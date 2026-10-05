"""Workspace (project-level) hooks and digest trust (``hooks.workspace_trust``).

A repository may ship hooks next to its code, and a hook runs a command, so a
declaration only earns its place in the runner after a human reviewed its
sha256 digest and granted it for that canonical workspace. These tests pin the
boundaries that make the feature safe to turn on: it stays off until the state
directory explicitly says otherwise (and while it is off nothing under the
workspace is read at all), discovery is read-only and refuses links, a digest
covers everything that affects the execution, nothing runs untrusted, a broken
trust store fails closed as a whole and says so identically through status,
grant and revoke, and ``xueness hooks trust`` plus the read-only HTTP route
report exactly what the run seam uses.

Everything runs on a temp state directory and workspace with
``sys.executable -c`` children writing marker files: no network, no real model.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness import cli, plugin_runtime
from xueness.bundled_plugins.hooks import tool_events, trust_api, workspace_hooks as trust
from xueness.bundled_plugins.hooks.plugin import HooksPlugin
from tests.fs_link_helpers import make_directory_boundary_link, make_symlink

TRUST_FILE = "hook-trust.json"
NATIVE = ".xueness/hooks.json"


def _marker_args(marker):
    """The argv a hook runs: append one line to ``marker``, then exit 0."""
    return ["-c", "open(%r, 'a').write('ran\\n')" % str(marker)]


class _Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.ws = self.root / "ws"
        self.state.mkdir()
        (self.ws / ".xueness").mkdir(parents=True)
        (self.state / "resources" / "hooks").mkdir(parents=True)

    # -- workspace and state fixtures ----------------------------------------

    def declaration(self, **over):
        row = {"event": "SessionStart", "command": sys.executable, "args": ["-c", "pass"]}
        row.update(over)
        return row

    @property
    def native_path(self):
        return self.ws / ".xueness" / "hooks.json"

    def write_native(self, document, path=None):
        (path or self.native_path).write_text(json.dumps(document), encoding="utf-8")

    def write_zcode(self, document):
        directory = self.ws / ".zcode"
        directory.mkdir(exist_ok=True)
        (directory / "config.json").write_text(json.dumps(document), encoding="utf-8")

    def workspace_file(self, name, document):
        target = self.root / name
        target.parent.mkdir(exist_ok=True)
        target.write_text(json.dumps(document), encoding="utf-8")
        return target

    def marker(self, name):
        return self.root / ("%s.log" % name)

    def running(self, name, **over):
        """A declaration whose command appends a line to a fresh marker."""
        marker = self.marker(name)
        return self.declaration(args=_marker_args(marker), **over), marker

    def enable(self, on=True):
        trust.set_feature(self.state, on)

    def found(self):
        return trust.discover(self.ws)

    def digests(self):
        return [row["digest"] for row in self.found()["hooks"]]

    def codes(self, document):
        return [item["code"] for item in document["diagnostics"]]

    def workspace_key(self):
        return trust.canonical_workspace(self.ws)

    def grant_found(self, index=None):
        rows = self.found()["hooks"]
        return trust.grant_trust(self.state, self.workspace_key(),
                                 rows if index is None else [rows[index]])

    # -- run seam -------------------------------------------------------------

    def runner(self, session=None):
        return HooksPlugin().load(self.state, self.ws, session or {"id": "session-1"})["hooks"]

    def fire(self, runner, event="SessionStart", **payload):
        body = {"session_id": "session-1", "tool_name": "read", "tool": "read"}
        body.update(payload)
        return runner.fire(event, body)

    def pending_notes(self, session):
        return [note for note in (session.get("hook_diagnostics") or [])
                if note.get("kind") == "pending_trust"]

    def write_user_hook(self, hook_id, marker, event="SessionStart", **over):
        item = {"id": hook_id, "event": event, "command": sys.executable,
                "args": _marker_args(marker), "enabled": True}
        item.update(over)
        (self.state / "resources" / "hooks" / ("%s.json" % hook_id)).write_text(
            json.dumps(item), encoding="utf-8")

    # -- CLI / HTTP -----------------------------------------------------------

    def invoke(self, *argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(["--state", str(self.state)] + [str(a) for a in argv])
        return code, stdout.getvalue(), stderr.getvalue()

    def invoke_json(self, *argv):
        if "--json" not in argv:
            argv = argv + ("--json",)
        code, stdout, stderr = self.invoke(*argv)
        self.assertEqual(code, 0, stderr)
        return json.loads(stdout)

    def http(self, method, query, parts=None, data=None):
        return plugin_runtime.dispatch_http(method,
                                           parts or ["api", "resources", "hooks", "trust"],
                                           query, data, self.http_ctx())

    def http_ctx(self):
        return {"state_dir": self.state, "web_runs": self.root,
                "project_dir": self.root, "workspace_roots": [self.ws]}


class FeatureSwitchTests(_Fixture):
    def test_off_by_default_reads_nothing_under_the_workspace(self):
        self.write_native({"hooks": [self.declaration()]})
        self.assertFalse(trust.feature_enabled(self.state),
                         "only an explicit enabled=true turns the feature on")
        with patch.object(trust, "discover",
                          side_effect=AssertionError("workspace read while disabled")) as probe:
            self.assertEqual(trust.admitted(self.state, self.ws, {})["reason"],
                             "feature_disabled")
            document = trust.status_document(self.state, self.ws)
            self.assertEqual(document["reason"], "feature_disabled")
            self.assertEqual(document["items"], [])
            self.assertEqual(document["bundleDigest"], None)
            self.assertEqual(trust.extend_for_runner(self.state, self.ws, [{"id": "user"}], {}),
                             [{"id": "user"}])
        probe.assert_not_called()
        self.assertFalse((self.state / TRUST_FILE).exists())

    def test_disabled_does_not_even_diagnose_a_linked_hook_root(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.write_native({"hooks": [self.declaration()]}, path=outside / "hooks.json")
        os.rmdir(self.ws / ".xueness")
        make_directory_boundary_link(self.ws / ".xueness", outside)

        self.assertEqual(trust.status_document(self.state, self.ws)["diagnostics"], [],
                         "a disabled feature must not look at the workspace at all")
        self.enable()
        self.assertIn("hook_root_symlink", self.codes(trust.status_document(self.state, self.ws)))

    def test_the_switch_is_strict_about_its_document(self):
        self.write_native({"hooks": [self.declaration()]})
        self.assertEqual(trust.feature_status(self.state),
                         {"enabled": False, "status": "absent"})
        path = self.state / trust.FEATURE_FILENAME
        for broken in ('{"enabled": "yes"}', '{"enabled": true, "extra": 1}', "{ oops", "[]"):
            path.write_text(broken, encoding="utf-8")
            self.assertEqual(trust.feature_status(self.state)["status"], "corrupt", broken)
            self.assertFalse(trust.feature_enabled(self.state), broken)
        self.enable()
        self.assertTrue(trust.feature_enabled(self.state))
        self.enable(False)
        self.assertFalse(trust.feature_enabled(self.state))

    def test_the_switch_file_must_not_be_a_link(self):
        target = self.root / "elsewhere.json"
        target.write_text('{"enabled": true}', encoding="utf-8")
        link = self.state / trust.FEATURE_FILENAME
        link.parent.mkdir(parents=True, exist_ok=True)
        make_symlink(link, target)
        with self.assertRaises(ValueError):
            trust.set_feature(self.state, True)
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"enabled": True})


class DiscoveryTests(_Fixture):
    def test_native_and_compat_files_and_their_broken_entries(self):
        self.write_native({"hooks": [
            self.declaration(),
            self.declaration(event="NotAnEvent"),
            self.declaration(command="   "),
            self.declaration(args="not-a-list"),
            self.declaration(timeout=0),
            self.declaration(enabled="yes"),
            self.declaration(pipeline=1),
            self.declaration(id=""),
            "not-an-object",
            self.declaration(id="dup", event="Stop", command="x"),
            self.declaration(id="dup", event="UserPromptSubmit", command="y"),
        ]})
        self.write_zcode({"hooks": {"enabled": True, "timeoutMs": 5000, "events": {
            "PreToolUse": [{"matcher": "read", "hooks": [
                {"type": "process", "command": sys.executable, "args": ["-c", "pass"]},
                {"type": "command", "command": "echo hi | sh"},
                {"type": "process", "command": ""},
            ]}],
            "NotAnEvent": [],
        }}})

        found = self.found()
        self.assertEqual([row["source"] for row in found["hooks"]],
                         ["project", "project", "project-compat"])
        compat = found["hooks"][2]
        self.assertEqual((compat["event"], compat["matcher"], compat["timeout"]),
                         ("PreToolUse", "read", 5.0))
        self.assertIsNotNone(found["bundleDigest"])
        for code in ("hook_invalid_event", "hook_invalid_command", "hook_invalid_args",
                     "hook_invalid_timeout", "hook_invalid_enabled", "hook_invalid_pipeline",
                     "hook_invalid_id", "hook_invalid_shape", "hook_duplicate_id",
                     "hook_unsupported_type"):
            self.assertIn(code, self.codes(found), code)
        digests = [row["digest"] for row in found["hooks"]]
        self.assertEqual(len(set(digests)), len(digests))

    def test_a_bare_array_is_accepted_and_disabled_rows_stay_visible(self):
        self.write_native([self.declaration(), self.declaration(id="off", enabled=False)])
        found = self.found()
        self.assertEqual([row["enabled"] for row in found["hooks"]], [True, False])
        self.assertEqual(self.codes(found), [])
        self.enable()
        self.grant_found()
        admitted = trust.admitted(self.state, self.ws, {})
        self.assertEqual([row["enabled"] for row in admitted["hooks"]], [True])
        self.assertEqual(admitted["reason"], "trusted")

    def test_the_compat_root_switch_disables_without_hiding(self):
        self.write_zcode({"hooks": {"enabled": False, "events": {
            "SessionStart": [{"hooks": [{"type": "process", "command": sys.executable}]}]}}})
        self.assertFalse(self.found()["hooks"][0]["enabled"])
        self.enable()
        self.assertEqual(trust.admitted(self.state, self.ws, {})["reason"], "no_enabled_hooks")

    def test_a_config_without_hooks_is_simply_not_a_hook_file(self):
        self.write_zcode({"model": "local"})
        found = self.found()
        self.assertEqual(found["hooks"], [])
        self.assertEqual(found["diagnostics"], [])

    def test_broken_documents_cost_the_file_or_the_entry_only(self):
        self.native_path.write_text("{ oops", encoding="utf-8")
        self.assertEqual(self.codes(self.found()), ["hook_invalid_json"])
        self.native_path.write_text(json.dumps({"hooks": "nope"}), encoding="utf-8")
        self.assertEqual(self.codes(self.found()), ["hook_invalid_shape"])
        self.native_path.write_text("x" * (trust.MAX_HOOKS_FILE_BYTES + 1), encoding="utf-8")
        self.assertEqual(self.codes(self.found()), ["hook_file_too_large"])
        self.native_path.write_bytes(b"\xff\xfe broken utf-8")
        self.assertEqual(self.codes(self.found()), ["hook_invalid_encoding"])

        rows = [self.declaration(id="ok-%d" % index)
                for index in range(trust.MAX_HOOKS_PER_SOURCE + 4)]
        rows.insert(2, self.declaration(event="NotAnEvent"))
        self.write_native({"hooks": rows})
        found = self.found()
        self.assertEqual(len(found["hooks"]), trust.MAX_HOOKS_PER_SOURCE)
        self.assertIn("hook_limit", self.codes(found))
        self.assertIn("hook_invalid_event", self.codes(found),
                      "one bad entry costs that entry, not the file")

    def test_discovery_never_writes_anything(self):
        self.write_native({"hooks": [self.declaration()]})
        self.found()
        self.assertEqual([p.name for p in self.ws.rglob("*") if p.is_file()], ["hooks.json"])
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ["resources"])

    def test_a_linked_hook_file_is_refused(self):
        self.write_native({"hooks": [self.declaration()]})
        hidden = self.workspace_file("elsewhere/hooks.json", {"hooks": [self.declaration()]})
        os.remove(self.native_path)
        make_symlink(self.native_path, hidden)
        found = self.found()
        self.assertEqual(found["hooks"], [])
        self.assertIn("hook_file_symlink", self.codes(found))

    def test_a_link_escaping_the_workspace_never_moves_the_jail(self):
        escaped = self.root / "outside-hooks"
        escaped.mkdir()
        self.workspace_file("outside-hooks/hooks.json", {"hooks": [self.declaration()]})
        os.rmdir(self.ws / ".xueness")
        make_directory_boundary_link(self.ws / ".xueness", escaped)
        found = self.found()
        self.assertEqual(found["hooks"], [])
        self.assertEqual(self.codes(found), ["hook_root_symlink"])
        self.enable()
        self.assertEqual(trust.admitted(self.state, self.ws, {})["hooks"], [])


class DigestTests(_Fixture):
    def test_a_digest_is_stable_per_declaration_and_not_per_workspace(self):
        base = self.declaration(matcher="read")
        self.write_native({"hooks": [base]})
        first = self.digests()
        bundle = self.found()["bundleDigest"]
        self.assertEqual(self.digests(), first)
        self.assertEqual(self.found()["bundleDigest"], bundle)

        other = self.root / "other"
        (other / ".xueness").mkdir(parents=True)
        self.write_native({"hooks": [base]}, path=other / ".xueness" / "hooks.json")
        self.assertEqual([row["digest"] for row in trust.discover(other)["hooks"]], first,
                         "trust is keyed by workspace + digest, so the digest itself must "
                         "not bake in the workspace path")

    def test_everything_that_changes_execution_changes_the_digest(self):
        base = self.declaration(matcher="read", timeout=5)
        second = self.declaration(id="second")
        self.write_native({"hooks": [base, second]})
        original = self.digests()
        bundle = self.found()["bundleDigest"]

        mutations = (
            ("command", {**base, "command": "/bin/echo"}),
            ("args", {**base, "args": ["-c", "print(1)"]}),
            ("matcher", {**base, "matcher": "write"}),
            ("event", {**base, "event": "Stop"}),
            ("id", {**base, "id": "renamed"}),
            ("timeout", {**base, "timeout": 9}),
            ("pipeline", {**base, "pipeline": True}),
        )
        for label, changed in mutations:
            self.write_native({"hooks": [changed, second]})
            self.assertNotEqual(self.digests()[0], original[0], label)
            self.assertNotEqual(self.found()["bundleDigest"], bundle, label)

        # position is part of what a reviewer read
        self.write_native({"hooks": [second, base]})
        moved = self.digests()
        self.assertNotEqual(moved[1], original[0])
        self.assertNotEqual(moved[0], original[1])

        # `enabled` is a switch, not content: the declaration keeps its trust,
        # the bundle changes so a --all-current grant has to be re-reviewed
        self.write_native({"hooks": [{**base, "enabled": False}, second]})
        self.assertEqual(self.digests()[0], original[0])
        self.assertNotEqual(self.found()["bundleDigest"], bundle)

    def test_edited_content_is_pending_trust_again_at_the_run_seam(self):
        row, marker = self.running("before")
        self.write_native({"hooks": [row]})
        self.enable()
        self.assertTrue(self.grant_found()["ok"])
        self.assertEqual([result["exit_code"] for result in self.fire(self.runner())], [0])

        edited, later = self.running("after")
        self.write_native({"hooks": [edited]})
        session = {"id": "session-1"}
        admitted = trust.admitted(self.state, self.ws, session)
        self.assertEqual(admitted["hooks"], [])
        self.assertEqual(admitted["reason"], "pending_trust")
        self.assertEqual([note["digest"] for note in self.pending_notes(session)],
                         [self.digests()[0]])
        self.assertEqual(self.fire(self.runner(session)), [])
        self.assertFalse(later.exists(), "the edited command never ran")


class TrustStoreTests(_Fixture):
    def test_grant_is_per_workspace_and_idempotent(self):
        self.write_native({"hooks": [self.declaration()]})
        self.enable()
        rows = self.found()["hooks"]
        elsewhere = str(self.root / "elsewhere")
        self.assertEqual(trust.grant_trust(self.state, elsewhere, rows)["granted"], 1)
        self.assertEqual(trust.admitted(self.state, self.ws, {})["hooks"], [],
                         "a record granted for another workspace admits nothing here")

        outcome = trust.grant_trust(self.state, self.workspace_key(), rows)
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["granted"], 1)
        self.assertEqual(trust.grant_trust(self.state, self.workspace_key(), rows)["granted"], 0,
                         "re-granting the same digest adds nothing")
        self.assertEqual([record["workspace"] for record in
                          trust.load_trust(self.state)["records"]],
                         [elsewhere, self.workspace_key()])
        self.assertEqual(len(trust.admitted(self.state, self.ws, {})["hooks"]), 1)

    def test_revoke_by_digest_and_all(self):
        self.write_native({"hooks": [self.declaration(), self.declaration(id="second")]})
        self.grant_found()
        digest = self.digests()[0]
        outcome = trust.revoke_trust(self.state, self.workspace_key(), [digest])
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["removed"], 1)
        self.assertEqual(len(trust.load_trust(self.state)["records"]), 1)
        self.assertEqual(trust.revoke_trust(self.state, self.workspace_key(),
                                           revoke_all=True)["removed"], 1)
        self.assertEqual(trust.load_trust(self.state)["records"], [])

    def test_the_store_never_grows_past_its_budget(self):
        records = [{"workspace": "/w%d" % index, "digest": "%064x" % index,
                    "decision": "trusted", "grantedAt": "2026-10-05T00:00:00+00:00"}
                   for index in range(trust.MAX_TRUST_RECORDS)]
        (self.state / TRUST_FILE).write_text(
            json.dumps({"schemaVersion": trust.TRUST_SCHEMA_VERSION, "records": records}),
            encoding="utf-8")
        self.assertEqual(trust.load_trust(self.state)["status"], "ok")
        self.write_native({"hooks": [self.declaration()]})
        outcome = self.grant_found()
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["reason"], "trust_store_full")
        loaded = trust.load_trust(self.state)
        self.assertEqual(loaded["status"], "ok",
                         "a refused grant must not create a store that reads as corrupt")
        self.assertEqual(len(loaded["records"]), trust.MAX_TRUST_RECORDS)

    def _good_record(self):
        return {"workspace": "/w", "digest": "0" * 64, "decision": "trusted",
                "grantedAt": "2026-10-05T00:00:00+00:00"}

    def _broken_documents(self):
        record = self._good_record()
        return [
            "{ not json",
            "[]",
            json.dumps({"records": []}),
            json.dumps({"schemaVersion": 2, "records": []}),
            json.dumps({"schemaVersion": True, "records": []}),
            json.dumps({"schemaVersion": 1, "records": [], "extra": 1}),
            json.dumps({"schemaVersion": 1, "records": {"a": 1}}),
            json.dumps({"schemaVersion": 1, "records": [{**record, "unknown": 1}]}),
            json.dumps({"schemaVersion": 1, "records": [{**record, "digest": "not-hex"}]}),
            json.dumps({"schemaVersion": 1, "records": [{**record, "decision": "maybe"}]}),
            json.dumps({"schemaVersion": 1, "records": [{**record, "workspace": ""}]}),
            json.dumps({"schemaVersion": 1, "records": [{**record, "grantedAt": 3}]}),
            json.dumps({"schemaVersion": 1, "records": [record, record]}),
        ]

    def test_a_broken_store_is_corrupt_for_status_grant_and_revoke_alike(self):
        self.write_native({"hooks": [self.declaration()]})
        self.enable()
        store = self.state / TRUST_FILE
        for broken in self._broken_documents():
            store.write_text(broken, encoding="utf-8")

            document = trust.status_document(self.state, self.ws)
            self.assertEqual(document["trustStatus"], "corrupt", broken)
            self.assertEqual(document["reason"], "trust_store_corrupt", broken)
            self.assertEqual(document["corruptPath"], str(store), broken)

            outcome = self.grant_found()
            self.assertFalse(outcome["ok"], broken)
            self.assertEqual(outcome["reason"], "trust_store_corrupt", broken)
            revoked = trust.revoke_trust(self.state, self.workspace_key(), revoke_all=True)
            self.assertFalse(revoked["ok"], broken)
            self.assertEqual(revoked["reason"], "trust_store_corrupt", broken)

            self.assertEqual(store.read_text(encoding="utf-8"), broken,
                             "reporting corruption must not rewrite the store")
            self.assertEqual([p.name for p in self.state.iterdir()
                              if p.name.startswith(TRUST_FILE)], [TRUST_FILE], broken)
            self.assertEqual(trust.load_trust(self.state)["status"], "corrupt",
                             "and the next read says the same thing")

        store.unlink()
        self.assertEqual(trust.load_trust(self.state)["status"], "absent")
        self.assertTrue(self.grant_found()["ok"])
        self.assertEqual(len(trust.load_trust(self.state)["records"]), 1)

    def test_a_linked_store_is_corrupt_and_never_written_through(self):
        target = self.workspace_file("foreign.json", {"schemaVersion": 1, "records": []})
        make_symlink(self.state / TRUST_FILE, target)
        self.write_native({"hooks": [self.declaration()]})
        self.enable()
        self.assertEqual(trust.status_document(self.state, self.ws)["reason"],
                         "trust_store_corrupt")
        self.assertFalse(self.grant_found()["ok"])
        self.assertFalse(trust.revoke_trust(self.state, self.workspace_key(),
                                           revoke_all=True)["ok"])
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")),
                         {"schemaVersion": 1, "records": []},
                         "a foreign file behind a link is never modified")

    def test_a_corrupt_store_admits_nothing(self):
        row, marker = self.running("corrupt-admission")
        self.write_native({"hooks": [row]})
        self.enable()
        self.grant_found()
        (self.state / TRUST_FILE).write_text("{ broken", encoding="utf-8")
        session = {"id": "session-1"}
        admitted = trust.admitted(self.state, self.ws, session)
        self.assertEqual(admitted["reason"], "trust_store_corrupt")
        self.assertEqual(admitted["hooks"], [])
        self.assertEqual(self.fire(self.runner(session)), [])
        self.assertFalse(marker.exists())
        self.assertEqual(len(self.pending_notes(session)), 1)


class AdmissionTests(_Fixture):
    def test_untrusted_hooks_never_run_and_are_noted_once(self):
        row, marker = self.running("pending")
        self.write_native({"hooks": [row]})
        self.enable()
        session = {"id": "session-1"}
        runner = self.runner(session)
        self.assertFalse(runner.active, "nothing is admitted yet")
        self.assertEqual(self.fire(runner), [])
        self.assertFalse(marker.exists())

        notes = self.pending_notes(session)
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["digest"], self.digests()[0])
        self.assertEqual(notes[0]["sourcePath"], NATIVE)
        self.assertEqual(notes[0]["event"], "SessionStart")

        self.runner(session)
        self.assertEqual(len(self.pending_notes(session)), 1,
                         "the same pending digest is not repeated across a session")

    def test_pending_trust_is_bounded_and_never_blocks_the_run(self):
        self.write_native({"hooks": [self.declaration(id="hook-%d" % index)
                                     for index in range(trust.MAX_DIAGNOSTICS + 10)]})
        self.enable()
        session = {"id": "session-1"}
        runner = self.runner(session)
        self.assertFalse(runner.active)
        self.assertEqual(self.fire(runner), [])
        notes = session["hook_diagnostics"]
        self.assertEqual(len(notes), trust.MAX_DIAGNOSTICS,
                         "the pending list is bounded, not the whole file")
        self.assertTrue(all(note["kind"] == "pending_trust" for note in notes))

    def test_a_granted_declaration_runs_and_a_disabled_one_still_does_not(self):
        row, marker = self.running("granted")
        self.write_native({"hooks": [row, self.declaration(id="off", enabled=False,
                                                          args=_marker_args(self.marker("off")))]})
        self.enable()
        self.grant_found()
        session = {"id": "session-1"}
        self.assertEqual([result["exit_code"] for result in self.fire(self.runner(session))], [0])
        self.assertEqual(marker.read_text(encoding="utf-8").splitlines(), ["ran"])
        self.assertFalse(self.marker("off").exists(), "granting trust is not enabling a hook")
        self.assertFalse(self.pending_notes(session))

    def test_user_hooks_come_first_and_keep_their_behaviour(self):
        user_marker, workspace_marker = self.marker("user"), self.marker("workspace")
        self.write_user_hook("user-hook", user_marker)
        self.write_native({"hooks": [self.declaration(args=_marker_args(workspace_marker))]})

        hooks = self.runner().hooks
        self.assertEqual([hook["id"] for hook in hooks], ["user-hook"],
                         "with the feature off the runner holds the user's hooks only")
        self.assertEqual([result["exit_code"] for result in self.fire(self.runner())], [0])
        self.assertEqual(len(user_marker.read_text(encoding="utf-8").splitlines()), 1)
        self.assertFalse(workspace_marker.exists())

        self.enable()
        self.assertEqual([hook["id"] for hook in self.runner().hooks], ["user-hook"])
        self.grant_found()
        merged = self.runner()
        self.assertEqual([hook["id"] for hook in merged.hooks],
                         ["user-hook", "workspace-hook-0-0"])
        self.fire(merged)
        self.assertEqual(len(user_marker.read_text(encoding="utf-8").splitlines()), 2)
        self.assertEqual(workspace_marker.read_text(encoding="utf-8").splitlines(), ["ran"])

    def test_a_revoked_declaration_stops_running(self):
        row, marker = self.running("revoked")
        self.write_native({"hooks": [row]})
        self.enable()
        self.grant_found()
        self.fire(self.runner())
        digest = self.digests()[0]
        trust.revoke_trust(self.state, self.workspace_key(), [digest])
        session = {"id": "session-1"}
        self.assertEqual(self.fire(self.runner(session)), [])
        self.assertEqual(len(marker.read_text(encoding="utf-8").splitlines()), 1)
        self.assertEqual([note["digest"] for note in self.pending_notes(session)], [digest])

    def test_pipeline_flagged_workspace_hook_fires_exactly_once(self):
        row, marker = self.running("pipeline")
        self.write_native({"hooks": [{**row, "event": "PostToolUse", "pipeline": True}]})
        self.enable()
        self.grant_found()
        runner = self.runner()
        self.assertIs(runner.hooks[0].get("pipeline"), True)
        self.assertEqual(self.fire(runner, "PostToolUse"), [],
                         "the legacy fire point leaves pipeline hooks to the pipeline")
        fired = runner.fire("PostToolUse", {"session_id": "s", "tool": "read",
                                           "tool_call_id": "c1"}, pipeline=True)
        self.assertEqual([result["exit_code"] for result in fired], [0])
        self.assertEqual(marker.read_text(encoding="utf-8").splitlines(), ["ran"])

        tool_events.fire_pipeline(self.ws, self.state, "PostToolUse",
                                  {"session_id": "s", "tool": "read", "tool_call_id": "c2"},
                                  session={"id": "session-1"})
        self.assertEqual(len(marker.read_text(encoding="utf-8").splitlines()), 2)

    def test_the_pipeline_seam_stays_out_of_the_way_when_the_feature_is_off(self):
        row, marker = self.running("pipeline-off")
        self.write_native({"hooks": [{**row, "event": "PostToolUse", "pipeline": True}]})
        fired = tool_events.fire_pipeline(self.ws, self.state, "PostToolUse",
                                         {"session_id": "s", "tool": "read"},
                                         session={"id": "session-1"})
        self.assertEqual(fired, [])
        self.assertFalse(marker.exists())

    def test_a_workspace_hook_can_block_a_tool_call_once_trusted(self):
        blocking = ["-c", "print('not from the repo'); raise SystemExit(2)"]
        self.write_native({"hooks": [self.declaration(event="PreToolUse", matcher="write",
                                                     args=blocking)]})
        self.enable()
        session = {"id": "session-1"}
        allowed, message = self.runner(session).pre_tool_use("write", {"path": "a"})
        self.assertTrue(allowed, "untrusted: the declaration never reached the runner")
        self.assertEqual(message, "")

        self.grant_found()
        allowed, message = self.runner().pre_tool_use("write", {"path": "a"})
        self.assertFalse(allowed)
        self.assertIn("not from the repo", message)
        self.assertTrue(self.runner().pre_tool_use("read", {"path": "a"})[0],
                        "the matcher still scopes the hook to its tool")


class CliTests(_Fixture):
    def test_the_switch_is_a_cli_opt_in(self):
        document = self.invoke_json("hooks", "workspace", "show", "--json")
        self.assertFalse(document["enabled"])
        self.assertEqual(self.invoke("hooks", "workspace", "on")[0], 0)
        self.assertTrue(trust.feature_enabled(self.state))
        self.invoke("hooks", "workspace", "off")
        self.assertFalse(trust.feature_enabled(self.state))

    def test_review_lists_every_declaration_with_its_trust_state(self):
        row, marker = self.running("review")
        self.write_native({"hooks": [{**row, "matcher": "read"}]})
        self.enable()
        document = self.invoke_json("hooks", "trust", "review", "--workspace", self.ws)
        self.assertTrue(document["featureEnabled"])
        self.assertEqual(document["reason"], "pending_trust")
        item = document["items"][0]
        self.assertEqual(item["trustState"], "pending_trust")
        self.assertEqual(item["event"], "SessionStart")
        self.assertEqual(item["matcher"], "read")
        self.assertEqual(item["sourcePath"], NATIVE)
        self.assertEqual(item["source"], "project")
        self.assertTrue(item["digest"])
        self.assertTrue(item["command"].startswith(sys.executable + " -c "),
                        item["command"])

        code, stdout, stderr = self.invoke("hooks", "trust", "review", "--workspace", self.ws)
        self.assertEqual(code, 0, stderr)
        self.assertIn("pending trust", stdout)
        self.assertIn("hooks trust grant", stdout)
        self.assertIn("--bundle-digest", stdout)

    def test_status_reports_diagnostics_and_the_bundle(self):
        self.write_native({"hooks": [self.declaration(), self.declaration(event="NotAnEvent")]})
        self.enable()
        document = self.invoke_json("hooks", "trust", "status", "--workspace", self.ws)
        self.assertEqual([item["trustState"] for item in document["items"]], ["pending_trust"])
        self.assertIn("hook_invalid_event", self.codes(document))
        self.assertEqual(document["bundleDigest"], self.found()["bundleDigest"])

    def test_grant_by_digest_then_revoke_by_digest(self):
        row, marker = self.running("grant")
        self.write_native({"hooks": [row]})
        self.enable()
        digest = self.digests()[0]

        document = self.invoke_json("hooks", "trust", "grant", "--workspace", self.ws,
                                   "--hook-digest", digest)
        self.assertEqual(document["granted"], 1)
        self.assertEqual(document["items"][0]["trustState"], "trusted")
        self.assertEqual([result["exit_code"] for result in self.fire(self.runner())], [0])
        self.assertEqual(marker.read_text(encoding="utf-8").splitlines(), ["ran"])

        document = self.invoke_json("hooks", "trust", "revoke", "--workspace", self.ws,
                                   "--hook-digest", digest)
        self.assertEqual(document["revoked"], 1)
        self.assertEqual(document["items"][0]["trustState"], "pending_trust")
        self.assertEqual(trust.admitted(self.state, self.ws, {})["hooks"], [])
        self.assertEqual(self.invoke_json("hooks", "trust", "revoke", "--workspace", self.ws,
                                         "--hook-digest", digest)["revoked"], 0,
                         "revoking what is not trusted is a no-op, not an error")

    def test_grant_refuses_a_missing_selection_and_an_unknown_digest(self):
        self.write_native({"hooks": [self.declaration()]})
        self.enable()
        code, stdout, stderr = self.invoke("hooks", "trust", "grant", "--workspace", self.ws)
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertIn("exactly one", stderr)
        code, stdout, stderr = self.invoke("hooks", "trust", "grant", "--workspace", self.ws,
                                          "--hook-digest", "f" * 64, "--json")
        self.assertEqual(code, 1)
        self.assertIn("digest_mismatch", json.loads(stdout)["reason"])
        code, stdout, stderr = self.invoke("hooks", "trust", "grant", "--workspace", self.ws,
                                          "--all-current")
        self.assertEqual(code, 1)
        self.assertIn("--bundle-digest", stderr)
        self.assertEqual(trust.load_trust(self.state)["status"], "absent")

    def test_all_current_refuses_a_bundle_that_moved_after_review(self):
        self.write_native({"hooks": [self.declaration()]})
        self.enable()
        reviewed = self.invoke_json("hooks", "trust", "status", "--workspace", self.ws)
        bundle, digest = reviewed["bundleDigest"], reviewed["items"][0]["digest"]

        self.write_native({"hooks": [self.declaration(id="renamed")]})
        code, stdout, stderr = self.invoke("hooks", "trust", "grant", "--workspace", self.ws,
                                          "--all-current", "--bundle-digest", bundle, "--json")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout)["reason"], "bundle_changed")
        self.assertEqual(trust.load_trust(self.state)["status"], "absent",
                         "a refused grant records no trust at all")

        self.write_native({"hooks": [self.declaration()]})
        document = self.invoke_json("hooks", "trust", "grant", "--workspace", self.ws,
                                   "--all-current", "--bundle-digest",
                                   self.found()["bundleDigest"])
        self.assertEqual(document["granted"], 1)
        self.assertEqual(document["items"][0]["digest"], digest)
        self.assertEqual(document["items"][0]["trustState"], "trusted")

    def test_all_current_grants_enabled_rows_only(self):
        self.write_native({"hooks": [self.declaration(),
                                     self.declaration(id="off", enabled=False)]})
        self.enable()
        document = self.invoke_json("hooks", "trust", "grant", "--workspace", self.ws,
                                   "--all-current", "--bundle-digest",
                                   self.found()["bundleDigest"])
        self.assertEqual(document["granted"], 1)
        states = {item["id"]: item["trustState"] for item in document["items"]}
        self.assertEqual(states["workspace-hook-0-0"], "trusted")
        self.assertEqual(states["off"], "pending_trust",
                         "an unchecked hook is not trusted by a bulk grant")

    def test_grant_refuses_while_the_feature_is_off_and_revoke_stays_available(self):
        self.write_native({"hooks": [self.declaration()]})
        digest = self.digests()[0]
        code, stdout, stderr = self.invoke("hooks", "trust", "grant", "--workspace", self.ws,
                                          "--hook-digest", digest)
        self.assertEqual(code, 1)
        self.assertIn("feature_disabled", stderr)
        with patch.object(trust, "discover", side_effect=AssertionError("workspace read")):
            document = self.invoke_json("hooks", "trust", "status", "--workspace", self.ws,
                                        "--json")
            self.assertEqual(document["reason"], "feature_disabled")
            self.assertEqual(self.invoke("hooks", "trust", "grant", "--workspace", self.ws,
                                         "--all-current", "--bundle-digest", "f" * 64)[0], 1)
            document = self.invoke_json("hooks", "trust", "revoke", "--workspace", self.ws,
                                        "--all", "--json")
        self.assertEqual(document["revoked"], 0, "revoking is a safe operation while disabled")

    def test_corrupt_store_is_reported_the_same_way_by_every_verb(self):
        self.write_native({"hooks": [self.declaration()]})
        self.enable()
        store = self.state / TRUST_FILE
        digest = self.digests()[0]

        store.write_text("{ broken", encoding="utf-8")
        document = self.invoke_json("hooks", "trust", "status", "--workspace", self.ws, "--json")
        self.assertEqual(document["trustStatus"], "corrupt")
        self.assertEqual(document["reason"], "trust_store_corrupt")
        code, stdout, _ = self.invoke("hooks", "trust", "status", "--workspace", self.ws)
        self.assertEqual(code, 0)
        self.assertIn("trust store corrupt", stdout)
        self.assertIn("hook-trust.json", stdout)

        code, stdout, _ = self.invoke("hooks", "trust", "grant", "--workspace", self.ws,
                                     "--hook-digest", digest, "--json")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout)["reason"], "trust_store_corrupt")
        code, stdout, _ = self.invoke("hooks", "trust", "revoke", "--workspace", self.ws,
                                     "--all", "--json")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout)["reason"], "trust_store_corrupt")
        self.assertEqual(store.read_text(encoding="utf-8"), "{ broken")
        self.assertEqual(self.invoke_json("hooks", "trust", "status", "--workspace", self.ws,
                                         "--json")["trustStatus"], "corrupt",
                         "a second status call must not have healed the store")

    def test_a_disabled_plugin_prints_nothing_and_exits_non_zero(self):
        self.write_native({"hooks": [self.declaration()]})
        self.enable()
        plugin_runtime.set_enabled(self.state, "hooks", False)
        for argv in (("hooks", "trust", "status", "--workspace", self.ws, "--json"),
                     ("hooks", "trust", "grant", "--workspace", self.ws,
                      "--hook-digest", "f" * 64),
                     ("hooks", "workspace", "on")):
            code, stdout, stderr = self.invoke(*argv)
            self.assertEqual(code, 1, argv)
            self.assertEqual(stdout, "", argv)
            self.assertIn("plugin disabled", stderr, argv)
        plugin_runtime.set_enabled(self.state, "hooks", True)
        self.assertEqual(self.invoke("hooks", "trust", "status", "--workspace", self.ws,
                                    "--json")[0], 0)


class HttpRouteTests(_Fixture):
    def test_status_is_read_only_and_fenced(self):
        self.write_native({"hooks": [self.declaration()]})
        status, body = self.http("GET", {"root": [str(self.ws)]})
        self.assertEqual(status, 200)
        self.assertEqual(body["reason"], "feature_disabled")
        self.assertEqual(body["items"], [])

        self.enable()
        status, body = self.http("GET", {"root": [str(self.ws)]})
        self.assertEqual(status, 200)
        self.assertEqual([item["trustState"] for item in body["items"]], ["pending_trust"])
        self.assertEqual(body["stateDir"], str(self.state))
        self.assertTrue(Path(body["workspace"]).is_absolute())

        status, body = self.http("GET", {"root": [str(self.root.parent)]})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "workspace root not permitted"})
        self.assertEqual(self.http("GET", {})[0], 400)

    def test_only_the_trust_path_is_claimed(self):
        parts = ["api", "resources", "hooks", "trust"]
        self.assertIsNone(trust_api.dispatch("POST", parts, {}, {"enabled": True},
                                            self.http_ctx()))
        self.assertIsNone(trust_api.dispatch("DELETE", parts, {}, None, self.http_ctx()))
        self.assertIsNone(trust_api.dispatch("GET", ["api", "resources", "hooks", "some-id"],
                                            {"root": [str(self.ws)]}, None, self.http_ctx()))
        self.assertIsNone(trust_api.dispatch("GET", ["api", "resources", "skills", "trust"],
                                            {"root": [str(self.ws)]}, None, self.http_ctx()))
        self.assertIsNone(trust_api.dispatch("GET", ["api", "resources", "hooks"],
                                            {"root": [str(self.ws)]}, None, self.http_ctx()))

    def test_the_hooks_resource_routes_still_work_through_the_plugin(self):
        status, body = plugin_runtime.dispatch_http("GET", ["api", "resources", "hooks"], {},
                                                   None, self.http_ctx())
        self.assertEqual(status, 200)
        self.assertEqual(body["items"], [])

    def test_the_route_disables_with_the_feature(self):
        self.write_native({"hooks": [self.declaration()]})
        self.enable()
        self.assertTrue(self.http("GET", {"root": [str(self.ws)]})[1]["featureEnabled"])
        trust.set_feature(self.state, False)
        with patch.object(trust, "discover", side_effect=AssertionError("workspace read")):
            status, body = self.http("GET", {"root": [str(self.ws)]})
        self.assertEqual(status, 200)
        self.assertEqual(body["reason"], "feature_disabled")


if __name__ == "__main__":
    unittest.main()
