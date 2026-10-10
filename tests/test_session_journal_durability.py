"""Journal and run-diagnostic durability under crash, CRLF, and concurrent writers.

The backup is a hardlink to the inode about to be replaced. Truncating that
live inode in place would truncate the backup too, so a torn publish is
simulated by overwriting the current name after a second save has moved the
backup onto the previous inode.
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from tests.fs_link_helpers import make_symlink
from tests.secret_permissions import assert_secret_file_private
from xueness import session_lease, write_lock
from xueness.bundled_plugins.sessions import http_routes
from xueness.core import Store
from xueness.session_lease import exclusive_lock, journal_lock, lease


_ROOT = str(Path(__file__).resolve().parents[1])


def _run(code, *args, timeout=30):
    env = os.environ.copy()
    env["PYTHONPATH"] = _ROOT + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    return subprocess.run(
        [sys.executable, "-c", code, *map(str, args)],
        capture_output=True, text=True, timeout=timeout, env=env, cwd=_ROOT,
    )


def _spawn(code, *args):
    env = os.environ.copy()
    env["PYTHONPATH"] = _ROOT + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    return subprocess.Popen(
        [sys.executable, "-c", code, *map(str, args)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=_ROOT,
    )


_CHILD_JOURNAL = """
import sys
from pathlib import Path
from xueness.core import Store
from xueness.session_lease import journal_lock
store = Store(Path(sys.argv[1]))
try:
    with journal_lock(store, sys.argv[2], timeout=float(sys.argv[3])):
        print("acquired")
except TimeoutError:
    print("timeout")
"""

_CHILD_LEASE = """
import sys
from pathlib import Path
from xueness.core import Store
from xueness.session_lease import lease
store = Store(Path(sys.argv[1]))
try:
    with lease(store, sys.argv[2]):
        print("acquired")
except BlockingIOError:
    print("busy")
"""

_CHILD_SAVE = """
import json, sys
from pathlib import Path
from xueness.core import Store
store = Store(Path(sys.argv[1]))
session = json.loads(sys.argv[2])
session["task"] = sys.argv[3]
for _ in range(8):
    store.save(session)
print("saved")
"""

_CHILD_DIAG = """
import sys
from xueness.bundled_plugins.sessions.http_routes import _append_run_diagnostic
state, start, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
for i in range(start, start + count):
    _append_run_diagnostic(state, '{"event":"session_run_failed","n":%d}' % i)
print("appended")
"""

_CHILD_DIAG_LOCK = """
import sys
from pathlib import Path
from xueness.session_lease import exclusive_lock
try:
    with exclusive_lock(Path(sys.argv[1]), "session-run-errors.lock", timeout=float(sys.argv[2])):
        print("acquired")
except TimeoutError:
    print("timeout")
"""


class _Handler:
    def __init__(self, store):
        self._ctx = {"store": store}
        self.sent = None
        self.path = ""
        self.headers = {}

    def _send(self, code, payload, content_type="application/json"):
        self.sent = (code, payload)


class JournalDurabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root / "state")

    def _finish(self, proc, expected):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), expected, proc.stderr)

    def test_save_is_utf8_lf_and_load_accepts_crlf_without_rewriting(self):
        session = self.store.new("行1\r\n行2 😀", self.root)
        path = self.store._path(session["id"])
        raw = path.read_bytes()
        self.assertEqual(raw, json.dumps(session, ensure_ascii=False, indent=2).encode("utf-8"))
        self.assertNotIn(b"\r", raw)
        self.assertIn("行1".encode(), raw)
        self.assertIn("😀".encode(), raw)
        self.assertIn(b"\\r\\n", raw)
        assert_secret_file_private(self, path)
        self.assertTrue((self.store.directory / ".locks" / (session["id"] + ".journal.lock")).is_file())
        self.assertFalse((self.store.directory / ".locks" / (session["id"] + ".lock")).exists())

        self.assertEqual(self.store.load(session["id"])["task"], "行1\r\n行2 😀")
        self.assertEqual(path.read_bytes(), raw)

        crlf = raw.replace(b"\n", b"\r\n")
        path.write_bytes(crlf)
        self.assertEqual(self.store.load(session["id"])["task"], "行1\r\n行2 😀")
        self.assertEqual(path.read_bytes(), crlf)

        session["task"] = "again"
        with mock.patch("xueness.core.os.fdopen", side_effect=AssertionError("text mode")):
            self.store.save(session)
        self.assertNotIn(b"\r", path.read_bytes())
        self.assertEqual(self.store.load(session["id"])["task"], "again")

    @unittest.skipUnless(os.name == "posix", "mocked platform must keep the posix lock opener")
    def test_mocked_darwin_and_win32_still_write_lf(self):
        for platform_name in ("darwin", "win32"):
            with self.subTest(platform=platform_name):
                self.assertEqual(session_lease.os.name, "posix")
                with mock.patch("sys.platform", platform_name):
                    session = self.store.new(platform_name + "-行", self.root)
                raw = self.store._path(session["id"]).read_bytes()
                self.assertNotIn(b"\r", raw)
                self.assertEqual(raw, json.dumps(session, ensure_ascii=False, indent=2).encode("utf-8"))

    def test_truncated_primary_restores_hardlink_backup_without_rotating_it(self):
        session = self.store.new("previous", self.root)
        path = self.store._path(session["id"])
        previous = path.read_bytes()
        session["task"] = "latest"
        self.store.save(session)
        backup = Path(str(path) + ".bak")
        self.assertEqual(backup.read_bytes(), previous)
        self.assertNotEqual(path.stat().st_ino, backup.stat().st_ino)
        backup_ino = backup.stat().st_ino

        path.write_bytes(b'{"id": "')
        loaded = self.store.load(session["id"])
        self.assertEqual(loaded["task"], "previous")
        self.assertEqual(backup.stat().st_ino, backup_ino)
        self.assertEqual(backup.read_bytes(), previous)
        repaired = json.loads(path.read_bytes().decode("utf-8"))
        self.assertEqual(repaired["task"], "previous")
        self.assertNotIn(b"\r", path.read_bytes())

        path.write_bytes(b'{"id": "')
        self.assertEqual(self.store.load(session["id"])["task"], "previous")
        self.assertEqual(backup.read_bytes(), previous)
        self.assertEqual(self.store.list(), [{
            "id": session["id"], "task": "previous", "status": "pending",
        }])

    def test_restore_returns_backup_when_rewriting_the_primary_fails(self):
        session = self.store.new("previous", self.root)
        path = self.store._path(session["id"])
        session["task"] = "latest"
        self.store.save(session)
        torn = b'{"id": "'
        path.write_bytes(torn)
        with mock.patch("xueness.core._replace_session_file", side_effect=OSError("disk")):
            loaded = self.store.load(session["id"])
        self.assertEqual(loaded["task"], "previous")
        self.assertEqual(path.read_bytes(), torn)

    def test_missing_primary_is_not_resurrected_from_backup(self):
        session = self.store.new("previous", self.root)
        path = self.store._path(session["id"])
        session["task"] = "latest"
        self.store.save(session)
        backup = Path(str(path) + ".bak")
        kept = backup.read_bytes()
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.store.load(session["id"])
        self.assertEqual(backup.read_bytes(), kept)
        self.assertEqual(self.store.list(), [])

    def test_valid_small_json_is_not_replaced_by_backup(self):
        session = self.store.new("previous", self.root)
        path = self.store._path(session["id"])
        session["task"] = "latest"
        self.store.save(session)
        path.write_bytes(b"{}")
        self.assertEqual(self.store.load(session["id"]), {})
        self.assertEqual(path.read_bytes(), b"{}")
        self.assertEqual(json.loads(Path(str(path) + ".bak").read_bytes().decode("utf-8"))["task"], "previous")

    def test_untrusted_backup_does_not_repair_a_torn_primary(self):
        session = self.store.new("previous", self.root)
        path = self.store._path(session["id"])
        session["task"] = "latest"
        self.store.save(session)
        backup = Path(str(path) + ".bak")
        backup.unlink()
        other = "0" * 32
        backup.write_bytes(json.dumps({
            "id": other, "task": "nope", "status": "pending",
        }).encode("utf-8"))
        path.write_bytes(b'{"id": "')
        with self.assertRaises(json.JSONDecodeError):
            self.store.load(session["id"])
        self.assertEqual(json.loads(backup.read_bytes().decode("utf-8"))["id"], other)

    def test_symlink_backup_is_not_followed(self):
        session = self.store.new("previous", self.root)
        path = self.store._path(session["id"])
        session["task"] = "latest"
        self.store.save(session)
        backup = Path(str(path) + ".bak")
        backup.unlink()
        outside = self.root / "outside.json"
        outside.write_text("secret-sentinel", encoding="utf-8")
        make_symlink(backup, outside)
        path.write_bytes(b'{"id": "')
        with self.assertRaises(json.JSONDecodeError):
            self.store.load(session["id"])
        self.assertEqual(outside.read_text(encoding="utf-8"), "secret-sentinel")
        self.assertTrue(os.path.islink(backup))

    def test_stale_session_temps_are_removed_and_fresh_ones_stay(self):
        session = self.store.new("temp", self.root)
        directory = self.store.directory
        old = time.time() - 120
        stale = directory / ".session-stale"
        stale.write_bytes(b"torn")
        os.utime(stale, (old, old))
        fresh = directory / ".session-fresh"
        fresh.write_bytes(b"live")
        fifo = directory / ".session-fifo"
        try:
            os.mkfifo(fifo)
        except (AttributeError, NotImplementedError, OSError):
            fifo = None
        else:
            os.utime(fifo, (old, old))
        session["task"] = "saved"
        self.store.save(session)
        self.assertFalse(stale.exists())
        self.assertEqual(fresh.read_bytes(), b"live")
        if fifo is not None:
            self.assertTrue(stat.S_ISFIFO(fifo.lstat().st_mode))

    def test_stale_session_temp_symlink_is_not_followed(self):
        session = self.store.new("temp", self.root)
        outside = self.root / "outside-temp"
        outside.write_text("keep", encoding="utf-8")
        link = self.store.directory / ".session-link"
        make_symlink(link, outside)
        session["task"] = "saved"
        self.store.save(session)
        self.assertTrue(os.path.islink(link))
        self.assertEqual(outside.read_text(encoding="utf-8"), "keep")

    def test_other_session_saves_while_this_journal_lock_is_held(self):
        first = self.store.new("a", self.root)
        second = self.store.new("b", self.root)
        with journal_lock(self.store, first["id"]):
            started = time.monotonic()
            second["task"] = "b2"
            self.store.save(second)
            self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.store.load(second["id"])["task"], "b2")

    def test_same_thread_journal_lock_reentry_times_out(self):
        session = self.store.new("reentry", self.root)
        started = time.monotonic()
        with journal_lock(self.store, session["id"], timeout=0.25):
            with self.assertRaises(TimeoutError):
                with journal_lock(self.store, session["id"], timeout=0.25):
                    self.fail("re-entered the journal lock")
        self.assertLess(time.monotonic() - started, 2)

    def test_bool_timeout_is_rejected(self):
        session = self.store.new("timeout", self.root)
        with self.assertRaises(ValueError):
            with exclusive_lock(self.store.directory / ".locks", session["id"] + ".extra", timeout=True):
                self.fail("accepted a boolean timeout")

    def test_lock_timeout_is_annotated_and_replace_keeps_its_stage(self):
        session = self.store.new("stage", self.root)
        now = {"value": 0.0}

        def monotonic():
            now["value"] += 100
            return now["value"]

        with mock.patch("xueness.session_lease.fcntl.flock", side_effect=BlockingIOError), \
                mock.patch("xueness.session_lease.time.monotonic", side_effect=monotonic), \
                mock.patch("xueness.session_lease.time.sleep"):
            with self.assertRaises(TimeoutError) as caught:
                self.store.save(session)
        self.assertEqual(caught.exception._xueness_store_stage, "lock")

        session["task"] = "replace"
        with mock.patch("xueness.core._replace_session_file", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError) as caught:
                self.store.save(session)
        self.assertEqual(caught.exception._xueness_store_stage, "replace")
        self.assertEqual(self.store.load(session["id"])["task"], "stage")

    def test_cross_process_journal_lock_and_lease_stay_distinct(self):
        session = self.store.new("locked", self.root)
        sid = session["id"]
        directory = str(self.store.directory)
        free = _run(_CHILD_JOURNAL, directory, sid, "0.5")
        self._finish(free, "acquired")
        with journal_lock(self.store, sid):
            blocked = _run(_CHILD_JOURNAL, directory, sid, "0.25")
        self._finish(blocked, "timeout")

        started = time.monotonic()
        with lease(self.store, sid):
            self.store.save(session)
            self.assertLess(time.monotonic() - started, 5)
            busy = _run(_CHILD_LEASE, directory, sid)
        self._finish(busy, "busy")

    def test_two_processes_leave_one_valid_journal(self):
        session = self.store.new("seed", self.root)
        payload = json.dumps({"id": session["id"], "task": "seed", "status": "pending"})
        directory = str(self.store.directory)
        first = _spawn(_CHILD_SAVE, directory, payload, "alpha")
        second = _spawn(_CHILD_SAVE, directory, payload, "beta")
        out_a, err_a = first.communicate(timeout=60)
        out_b, err_b = second.communicate(timeout=60)
        self.assertEqual(first.returncode, 0, err_a)
        self.assertEqual(second.returncode, 0, err_b)
        self.assertEqual(out_a.strip(), "saved")
        self.assertEqual(out_b.strip(), "saved")
        raw = self.store._path(session["id"]).read_bytes()
        self.assertNotIn(b"\r", raw)
        parsed = json.loads(raw.decode("utf-8"))
        self.assertEqual(parsed["id"], session["id"])
        self.assertIn(parsed["task"], ("alpha", "beta"))
        self.assertEqual(list(self.store.directory.glob(".session-*")), [])

    def test_two_threads_leave_one_valid_journal(self):
        session = self.store.new("seed", self.root)
        errors = []

        def worker(task):
            try:
                body = {"id": session["id"], "task": task, "status": "pending"}
                for _ in range(8):
                    self.store.save(body)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(task,)) for task in ("alpha", "beta")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        raw = self.store._path(session["id"]).read_bytes()
        parsed = json.loads(raw.decode("utf-8"))
        self.assertEqual(parsed["id"], session["id"])
        self.assertIn(parsed["task"], ("alpha", "beta"))
        self.assertNotIn(b"\r", raw)

    def test_host_path_folding_shares_the_in_process_journal_lock(self):
        sid = "a" * 32
        left = Store(self.root / "case-left")
        right = Store(self.root / "case-right")
        # Assigned, not resolved, so a case-insensitive volume still yields two spellings.
        left.directory = self.root / "State"
        right.directory = self.root / "state"
        with mock.patch.object(write_lock.sys, "platform", "linux"), \
                mock.patch.object(write_lock.os, "name", "posix"):
            self.assertIsNot(left._thread_lock(sid), right._thread_lock(sid))
        again = Store(self.store.directory)
        self.assertIs(self.store._thread_lock(sid), again._thread_lock(sid))

        with mock.patch.object(write_lock.sys, "platform", "darwin"), \
                mock.patch.object(write_lock.os, "name", "posix"):
            folded_left = left._thread_lock(sid)
            folded_right = right._thread_lock(sid)
        self.assertIs(folded_left, folded_right)

        with mock.patch.object(write_lock.sys, "platform", "win32"), \
                mock.patch.object(write_lock.os, "name", "nt"), \
                mock.patch.object(write_lock.os.path, "normcase", side_effect=str.casefold):
            win_left = left._thread_lock(sid)
            win_right = right._thread_lock(sid)
        self.assertIs(win_left, win_right)
        self.assertEqual(session_lease.os.name, os.name)

    def test_missing_nofollow_fails_closed_for_the_journal_lock(self):
        session = self.store.new("nofollow", self.root)
        with mock.patch.object(session_lease.os, "O_NOFOLLOW", 0), \
                mock.patch.object(session_lease.os, "open", side_effect=AssertionError("opened")):
            with self.assertRaisesRegex(OSError, "without following a link"):
                with journal_lock(self.store, session["id"]):
                    self.fail("opened a journal lock without O_NOFOLLOW")

    def test_read_routes_report_journal_lock_timeout_as_busy(self):
        session = self.store.new("busy", self.root)
        sid = session["id"]
        handler = _Handler(self.store)
        routes = (
            (["api", "sessions", sid], f"/api/sessions/{sid}"),
            (["api", "sessions", sid, "events"], f"/api/sessions/{sid}/events"),
            (["api", "sessions", sid, "events.v1"], f"/api/sessions/{sid}/events.v1"),
            (["api", "sessions", sid, "journal"], f"/api/sessions/{sid}/journal"),
        )
        with mock.patch.object(Store, "load", side_effect=TimeoutError("timed out waiting for a file lock")):
            for parts, path in routes:
                with self.subTest(path=path):
                    handler.path = path
                    self.assertTrue(http_routes.handle_GET(handler, parts, path, None))
                    self.assertEqual(handler.sent, (409, {"error": "session is in use by another process"}))

        missing = "c" * 32
        handler.path = f"/api/sessions/{missing}"
        self.assertTrue(http_routes.handle_GET(
            handler, ["api", "sessions", missing], handler.path, None))
        self.assertEqual(handler.sent, (404, {"error": "session not found"}))


class WindowsJournalLockTests(unittest.TestCase):
    def _patches(self, attributes, fd):
        return (
            mock.patch.object(session_lease.os, "name", "nt"),
            mock.patch("sys.platform", "win32"),
            mock.patch.object(session_lease, "_win32_open_directory", return_value=101),
            mock.patch.object(session_lease, "_win32_attributes", side_effect=attributes),
            mock.patch.object(session_lease, "_win32_create_relative", return_value=202),
            mock.patch.object(session_lease, "_win32_fd", return_value=fd),
            mock.patch.object(session_lease, "_close_handle"),
        )

    def test_reparse_directory_is_refused_before_the_journal_lock_is_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = Store(root / "state")
            session = store.new("lease", root)
            patches = self._patches([session_lease._FILE_ATTRIBUTE_REPARSE_POINT
                                     | session_lease._FILE_ATTRIBUTE_DIRECTORY], None)
            with patches[0], patches[1], patches[2] as open_dir, patches[3], \
                    patches[4] as create, patches[5] as to_fd, patches[6] as close, \
                    mock.patch.object(session_lease.fcntl, "flock") as flock:
                with self.assertRaisesRegex(ValueError, "invalid lock directory"):
                    with journal_lock(store, session["id"]):
                        self.fail("locked through a reparse directory")
            open_dir.assert_called_once()
            create.assert_not_called()
            to_fd.assert_not_called()
            flock.assert_not_called()
            close.assert_called_once_with(101)

    def test_regular_handle_locks_the_journal_file_not_the_lease_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = Store(root / "state")
            session = store.new("lease", root)
            held = os.open(root / "held.lock", os.O_CREAT | os.O_RDWR, 0o600)
            patches = self._patches([session_lease._FILE_ATTRIBUTE_DIRECTORY, 0x20], held)
            try:
                with patches[0], patches[1], patches[2], patches[3], patches[4] as create, \
                        patches[5], patches[6] as close, \
                        mock.patch.object(session_lease.fcntl, "flock") as flock:
                    with journal_lock(store, session["id"]):
                        flock.assert_called_once()
                        self.assertEqual(flock.call_args.args[0], held)
                create.assert_called_once_with(101, session["id"] + ".journal.lock")
                close.assert_called_once_with(101)
                with self.assertRaises(OSError):
                    os.fstat(held)
                held = None
            finally:
                if held is not None:
                    os.close(held)


class DiagnosticDurabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.path = self.state / "diagnostics" / "session-run-errors.jsonl"

    def _append(self, number):
        http_routes._append_run_diagnostic(
            self.state, '{"event":"session_run_failed","n":%d}' % number)

    def _line(self, number):
        return ('{"event":"session_run_failed","n":%d}\n' % number).encode("utf-8")

    def test_append_is_utf8_lf_and_private(self):
        with mock.patch("xueness.bundled_plugins.sessions.http_routes.os.fdopen",
                        side_effect=AssertionError("text mode")):
            http_routes._append_run_diagnostic(
                self.state, '{"event":"session_run_failed","note":"断电"}')
        raw = self.path.read_bytes()
        self.assertTrue(raw.endswith(b"\n"))
        self.assertNotIn(b"\r", raw)
        self.assertEqual(json.loads(raw.decode("utf-8")), {
            "event": "session_run_failed", "note": "断电",
        })
        assert_secret_file_private(self, self.path)
        self.assertTrue((self.state / "diagnostics" / ".locks" / "session-run-errors.lock").is_file())

    def test_crlf_file_is_rewritten_to_lf_on_the_next_append(self):
        self.path.parent.mkdir()
        self.path.write_bytes(b'{"event":"session_run_failed","n":1}\r\n')
        self._append(2)
        raw = self.path.read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertEqual([json.loads(line)["n"] for line in raw.splitlines()], [1, 2])

    def test_torn_tail_is_dropped_and_complete_lines_stay(self):
        self.path.parent.mkdir()
        self.path.write_bytes(self._line(1) + b'{"event":"ses')
        self._append(2)
        self.assertEqual(self.path.read_bytes(), self._line(1) + self._line(2))

        self.path.write_bytes(b'{"event":"se')
        self._append(3)
        self.assertEqual(self.path.read_bytes(), self._line(3))

    def test_short_write_is_repaired_by_the_next_append(self):
        self._append(1)
        real_write = os.write

        def short(fd, data):
            real_write(fd, bytes(data[:3]))
            raise OSError("torn diagnostic write")

        with mock.patch("xueness.bundled_plugins.sessions.http_routes.os.write", side_effect=short):
            self._append(2)
        self.assertEqual(self.path.read_bytes(), self._line(1) + b'{"e')
        self._append(3)
        self.assertEqual(self.path.read_bytes(), self._line(1) + self._line(3))

    def test_failed_rotation_keeps_complete_lines(self):
        original = http_routes._RUN_DIAGNOSTIC_MAX_BYTES
        try:
            http_routes._RUN_DIAGNOSTIC_MAX_BYTES = len(self._line(1)) * 2
            self._append(1)
            self._append(2)
            kept = self.path.read_bytes()
            self.assertEqual(kept, self._line(1) + self._line(2))
            with mock.patch("xueness.bundled_plugins.sessions.http_routes.replace_file",
                            side_effect=OSError("replace failed")):
                self._append(3)
            self.assertEqual(self.path.read_bytes(), kept)
        finally:
            http_routes._RUN_DIAGNOSTIC_MAX_BYTES = original

    def test_reader_ignores_bad_lines_and_does_not_rewrite(self):
        self.path.parent.mkdir()
        original = b'{"event":"session_run_failed","a":1}\r\nnot-json\n[]\n{"event":"ses'
        self.path.write_bytes(original)
        self.assertEqual(http_routes._read_run_diagnostics(self.state), [
            {"event": "session_run_failed", "a": 1},
        ])
        self.assertEqual(self.path.read_bytes(), original)

    def test_embedded_newline_or_cr_is_refused(self):
        http_routes._append_run_diagnostic(self.state, '{"a":1}\n{"b":2}')
        http_routes._append_run_diagnostic(self.state, "bad\rline")
        self.assertFalse(self.path.exists())

    def test_two_threads_and_two_processes_append_complete_lines(self):
        errors = []

        def worker(start):
            try:
                for number in range(start, start + 20):
                    self._append(number)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(0,)),
                   threading.Thread(target=worker, args=(20,))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])

        first = _spawn(_CHILD_DIAG, self.state, "40", "15")
        second = _spawn(_CHILD_DIAG, self.state, "55", "15")
        _, err_a = first.communicate(timeout=60)
        _, err_b = second.communicate(timeout=60)
        self.assertEqual(first.returncode, 0, err_a)
        self.assertEqual(second.returncode, 0, err_b)
        raw = self.path.read_bytes()
        self.assertTrue(raw.endswith(b"\n"))
        self.assertNotIn(b"\r", raw)
        parsed = [json.loads(line)["n"] for line in raw.splitlines()]
        self.assertEqual(sorted(parsed), list(range(70)))

    def test_cross_process_diagnostic_lock_times_out(self):
        (self.state / "diagnostics").mkdir()
        locks = self.state / "diagnostics" / ".locks"
        free = _run(_CHILD_DIAG_LOCK, locks, "0.5")
        self.assertEqual(free.returncode, 0, free.stderr)
        self.assertEqual(free.stdout.strip(), "acquired", free.stderr)
        with exclusive_lock(locks, "session-run-errors.lock"):
            blocked = _run(_CHILD_DIAG_LOCK, locks, "0.25")
        self.assertEqual(blocked.returncode, 0, blocked.stderr)
        self.assertEqual(blocked.stdout.strip(), "timeout", blocked.stderr)

    def test_oversized_prefix_is_replaced_down_to_the_tail(self):
        self.path.parent.mkdir()
        first = b'{"event":"session_run_failed","marker":"head"}\n'
        filler = b'{"event":"session_run_failed","pad":"' + (b"x" * 80) + b'"}\n'
        blob = first + filler * ((1024 * 1024) // len(filler) + 2)
        self.assertGreater(len(blob), 1024 * 1024)
        self.path.write_bytes(blob)
        self._append(7)
        raw = self.path.read_bytes()
        self.assertLess(len(raw), 70 * 1024)
        self.assertNotIn(b'"marker":"head"', raw)
        self.assertTrue(raw.endswith(self._line(7)))
        self.assertNotIn(b"\r", raw)
        for line in raw.splitlines():
            json.loads(line)

    def test_fifo_diagnostic_path_does_not_block(self):
        diagnostics = self.state / "diagnostics"
        diagnostics.mkdir()
        try:
            os.mkfifo(self.path)
        except (AttributeError, NotImplementedError, OSError):
            self.skipTest("this platform cannot create a fifo")
        box = {}

        def write():
            self._append(1)
            box["wrote"] = True

        def read():
            box["rows"] = http_routes._read_run_diagnostics(self.state)

        writer = threading.Thread(target=write, daemon=True)
        reader = threading.Thread(target=read, daemon=True)
        writer.start()
        reader.start()
        writer.join(2)
        reader.join(2)
        self.assertFalse(writer.is_alive())
        self.assertFalse(reader.is_alive())
        self.assertTrue(box.get("wrote"))
        self.assertEqual(box.get("rows"), [])
        self.assertTrue(stat.S_ISFIFO(self.path.lstat().st_mode))


if __name__ == "__main__":
    unittest.main()
