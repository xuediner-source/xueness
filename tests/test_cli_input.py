"""Multiline drafts and explicit bounded workspace attachments."""
import hashlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from tests.fs_link_helpers import make_symlink
from xueness.cli import main
from xueness.cli_input import (
    _MACOS_CLIPBOARD_SCRIPT, capture_clipboard_image, enqueue, multiline, snapshot, with_attachments,
)
from xueness.core import Store


class InputTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / "workspace"
        self.root.mkdir()
        self.store = Store(self.base / "state")
        from tests.fake_provider_fixture import patch_provider_resolution
        patch_provider_resolution(self)

    def invoke(self, args, text=""):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), mock.patch("sys.stdin", io.StringIO(text)):
            try:
                code = main(["--state", str(self.store.directory), *args])
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue(), err.getvalue()

    def chat(self, text, *flags):
        return self.invoke(["chat", "--root", str(self.root), "--allow-write", *flags], text)

    def session(self, out):
        return self.store.load(json.loads(out)["id"])

    def test_multiline_keeps_newlines_and_slash_commands_literal(self):
        code, out, err = self.chat("/paste\n  /mode plan\n\ncode\n\\/end\n/end\n/exit\n")
        self.assertEqual(code, 0, err)
        s = self.session(out)
        self.assertEqual(s["task"], "  /mode plan\n\ncode\n/end")
        self.assertEqual(s["mode"], "build")
        self.assertEqual(s["messages"][1]["content"], s["task"])

    def test_cancel_and_eof_do_not_submit_partial_draft(self):
        for text in ("/paste\npartial\n/cancel\n/exit\n", "/paste\npartial\n"):
            code, out, err = self.chat(text)
            self.assertEqual(code, 0, err)
            self.assertEqual(out, "")
            self.assertEqual(self.store.list(), [])

    def test_ctrl_c_cancels_only_the_multiline_draft(self):
        prompt = mock.Mock(side_effect=["partial", KeyboardInterrupt])
        self.assertIsNone(multiline(prompt))

    def test_overflow_drains_to_end_without_running_pasted_commands(self):
        code, out, err = self.chat("/paste\n" + "x" * 5001 + "\n/mode plan\n/end\ntask\n/exit\n")
        self.assertEqual(code, 0, err)
        self.assertIn("整段未提交", err)
        self.assertEqual(self.session(out)["task"], "task")
        self.assertEqual(self.session(out)["mode"], "build")

    def test_attachment_is_explicit_untrusted_snapshot_with_audit(self):
        path = self.root / "my code.py"
        data = "print('hello')\n"
        # Keep the attachment bytes stable on Windows, where text-mode writes
        # otherwise translate LF to CRLF before the snapshot hashes the file.
        path.write_bytes(data.encode("utf-8"))
        code, out, err = self.chat('/attach "my code.py"\n/attachments\nReview this\n/exit\n')
        self.assertEqual(code, 0, err)
        s = self.session(out)
        self.assertEqual(s["task"], "Review this")
        self.assertIn("UNTRUSTED DATA", s["messages"][1]["content"])
        self.assertIn("print('hello')", s["messages"][1]["content"])
        self.assertEqual(s["input_attachments"], [{"user_turn": 1, "files": [{
            "path": "my code.py", "bytes": len(data.encode()),
            "sha256": hashlib.sha256(data.encode()).hexdigest()}]}])

    def test_snapshot_does_not_change_when_file_is_modified(self):
        path = self.root / "file.txt"
        path.write_text("old")
        item = snapshot(self.root, "file.txt")
        path.write_text("new")
        s = self.store.new("inspect", self.root, attachments=[item])
        self.assertIn('"content": "old"', s["messages"][1]["content"])

    def test_queue_survives_cancel_and_is_consumed_once(self):
        (self.root / "f.txt").write_text("file snapshot")
        code, out, err = self.chat("/attach f.txt\n/paste\n/cancel\nfirst\nsecond\n/exit\n")
        self.assertEqual(code, 0, err)
        s = self.session(out)
        turns = [m["content"] for m in s["messages"] if m["role"] == "user"]
        self.assertIn("file snapshot", turns[0])
        self.assertEqual(turns[1], "second")
        self.assertEqual(len(s["input_attachments"]), 1)

    def test_detach_removes_queued_file_without_deleting_source(self):
        (self.root / "f.txt").write_text("sample")
        code, out, err = self.chat("/attach f.txt\n/detach 1\ntask\n/exit\n")
        self.assertEqual(code, 0, err)
        self.assertNotIn("input_attachments", self.session(out))
        self.assertEqual((self.root / "f.txt").read_text(), "sample")

    def test_path_escape_binary_and_special_files_are_rejected(self):
        (self.base / "outside").write_text("private")
        make_symlink(self.root / "escape", self.base / "outside")
        (self.root / "binary").write_bytes(b"\x00\xff")
        (self.root / "nul").write_bytes(b"abc\0")
        os.mkfifo(self.root / "pipe")
        for name in ("../outside", "escape", "binary", "nul", "pipe", "."):
            with self.subTest(name=name), self.assertRaises((ValueError, OSError)):
                snapshot(self.root, name)

    def test_size_limits_and_queue_replacement_are_atomic(self):
        queue = []
        for name in ("a", "b"):
            (self.root / name).write_text(name * 8000)
            enqueue(queue, snapshot(self.root, name))
        enqueue(queue, snapshot(self.root, "a"))
        self.assertEqual(len(queue), 2)
        (self.root / "c").write_text("extra")
        before = list(queue)
        with self.assertRaises(ValueError):
            enqueue(queue, snapshot(self.root, "c"))
        self.assertEqual(queue, before)
        for size in (8001, 65537):
            (self.root / "large").write_text("x" * size)
            with self.assertRaises(ValueError):
                snapshot(self.root, "large")
        queue.clear()
        for i in range(5):
            (self.root / str(i)).write_text("x")
            if i < 4:
                enqueue(queue, snapshot(self.root, str(i)))
            else:
                with self.assertRaises(ValueError):
                    enqueue(queue, snapshot(self.root, str(i)))

    def test_one_shot_attachment_and_invalid_attachment_no_journal(self):
        code, _, _ = self.invoke(["run", "--prompt", "task", "--root", str(self.root),
                                 "--attach", "missing"])
        self.assertEqual(code, 2)
        self.assertEqual(self.store.list(), [])
        (self.root / "f").write_text("data")
        code, out, err = self.invoke(["run", "--prompt", "task", "--root", str(self.root),
                                      "--allow-write", "--attach", "f"])
        self.assertEqual(code, 0, err)
        self.assertIn('"content": "data"', self.session(out)["messages"][1]["content"])

    def test_answer_can_be_multiline_with_attachment_and_resume(self):
        s = self.store.new("task", self.root)
        s.update(status="awaiting_user", pending_question="What next?")
        self.store.save(s)
        (self.root / "f").write_text("context")
        code, out, err = self.invoke(["chat", s["id"], "--allow-write", "--attach", "f"],
                                    "/paste\n  answer\nsecond line\n/end\n/exit\n")
        self.assertEqual(code, 0, err)
        s = self.session(out)
        self.assertEqual(s["status"], "completed")
        self.assertTrue(s["messages"][2]["content"].startswith("Operator answer:   answer\nsecond line"))
        self.assertEqual(s["input_attachments"][0]["user_turn"], 2)

    def test_followup_paste_preserves_indentation(self):
        code, out, err = self.chat("task\n/paste\n  indented\n\n  last\n/end\n/exit\n")
        self.assertEqual(code, 0, err)
        turns = [m["content"] for m in self.session(out)["messages"] if m["role"] == "user"]
        self.assertEqual(turns[-1], "  indented\n\n  last")

    def test_image_pdf_and_video_snapshots_are_bounded_and_encoded(self):
        image = self.root / "image.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\nimage")
        pdf = self.root / "brief.pdf"
        pdf.write_bytes(b"%PDF-1.7 demo")
        video = self.root / "clip.mp4"
        video.write_bytes(b"\x00\x00\x00\x18ftypmp42demo")
        image_item = snapshot(self.root, image.name)
        pdf_item = snapshot(self.root, pdf.name)
        with mock.patch("xueness.cli_input._extract_video_frames", return_value=("ZmFrZQ==",)):
            video_item = snapshot(self.root, video.name)
        self.assertEqual("image/png", image_item.mime_type)
        self.assertEqual("application/pdf", pdf_item.mime_type)
        self.assertEqual(("ZmFrZQ==",), video_item.frames)
        payload = with_attachments("inspect these", [image_item, pdf_item, video_item])
        encoded = json.loads(payload.split("XUENESS_MULTIMODAL_V1:", 1)[1])
        self.assertEqual(["image/png", "application/pdf", "video/mp4"],
                         [item["mimeType"] for item in encoded])
        self.assertEqual(1, encoded[2]["frames"])

    def test_media_extension_must_match_signature_and_total_bytes_are_bounded(self):
        mislabeled = self.root / "spoof.png"
        mislabeled.write_text("ordinary text", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "extension does not match"):
            snapshot(self.root, mislabeled.name)
        from xueness.cli_input import Attachment
        queue = [Attachment(str(i), "", 1_500_000, "h", "image/png", "aGVsbG8=") for i in range(3)]
        candidate = Attachment("last", "", 1_000_000, "h", "image/png", "aGVsbG8=")
        with self.assertRaises(ValueError):
            enqueue(queue, candidate)

    def test_explicit_linux_clipboard_capture_is_png_only_and_bounded(self):
        from xueness.cli_input import Attachment, MAX_MEDIA_FILE_BYTES

        class ClipboardProcess:
            def __init__(self, payload):
                self.stdout = io.BytesIO(payload)
                self.returncode = None
                self.terminated = False
            def wait(self, timeout=None):
                self.returncode = 0
                return self.returncode
            def poll(self):
                return self.returncode
            def terminate(self):
                self.terminated = True
                self.returncode = -15

        png = b"\x89PNG\r\n\x1a\n" + b"bounded image bytes"
        proc = ClipboardProcess(png)
        with mock.patch("xueness.bundled_plugins.sessions.cli_input.platform.system", return_value="Linux"), \
             mock.patch("xueness.bundled_plugins.sessions.cli_input.shutil.which",
                        side_effect=lambda name: "/usr/bin/wl-paste" if name == "wl-paste" else None), \
             mock.patch("xueness.bundled_plugins.sessions.cli_input.subprocess.Popen", return_value=proc) as popen:
            attachment = capture_clipboard_image(self.root)
        self.assertIsInstance(attachment, Attachment)
        self.assertEqual("image/png", attachment.mime_type)
        self.assertEqual("clipboard-image.png", attachment.path)
        self.assertEqual(len(png), attachment.size)
        self.assertNotIn(png, popen.call_args.args[0])
        self.assertEqual([], list(self.root.glob(".xueness-clipboard-*")))

        for payload, message in ((b"", "empty"), (b"not a png", "valid PNG"),
                                 (b"\x89PNG\r\n\x1a\n" + b"x" * (MAX_MEDIA_FILE_BYTES + 1), "exceeds")):
            proc = ClipboardProcess(payload)
            with self.subTest(message=message), \
                 mock.patch("xueness.bundled_plugins.sessions.cli_input.platform.system", return_value="Linux"), \
                 mock.patch("xueness.bundled_plugins.sessions.cli_input.shutil.which",
                            side_effect=lambda name: "/usr/bin/wl-paste" if name == "wl-paste" else None), \
                 mock.patch("xueness.bundled_plugins.sessions.cli_input.subprocess.Popen", return_value=proc), \
                 self.assertRaisesRegex(ValueError, message):
                capture_clipboard_image(self.root)

    def test_explicit_macos_clipboard_capture_uses_file_not_stdout(self):
        png = b"\x89PNG\r\n\x1a\nprivate"

        def fake_osascript(argv, **kwargs):
            script = argv[2]
            self.assertIn("«class PNGf»", script)
            self.assertNotIn(png.decode("latin1"), script)
            self.assertEqual(argv[1], "-e")
            self.assertEqual(len(argv), 4)
            Path(argv[3]).write_bytes(png)
            return mock.Mock(returncode=0, stdout=b"captured")

        with mock.patch("xueness.bundled_plugins.sessions.cli_input.platform.system", return_value="Darwin"), \
             mock.patch("xueness.bundled_plugins.sessions.cli_input.shutil.which", return_value="/usr/bin/osascript"), \
             mock.patch("xueness.bundled_plugins.sessions.cli_input.subprocess.run", side_effect=fake_osascript) as run:
            attachment = capture_clipboard_image(self.root)
        self.assertEqual("image/png", attachment.mime_type)
        self.assertEqual(subprocess.DEVNULL, run.call_args.kwargs["stdout"])

    def test_macos_clipboard_path_stays_argv_for_windows_and_macos_names(self):
        png = b"\x89PNG\r\n\x1a\nprivate"
        hostile = self.root / 'say "hello"\nbeep'
        hostile.mkdir()
        captured = {}

        def fake_osascript(argv, **kwargs):
            captured["argv"] = list(argv)
            Path(argv[-1]).write_bytes(png)
            return mock.Mock(returncode=0)

        for system in ("Darwin", "Windows"):
            with self.subTest(system=system):
                if system == "Windows":
                    with mock.patch("xueness.bundled_plugins.sessions.cli_input.platform.system", return_value="Windows"), \
                         mock.patch("xueness.bundled_plugins.sessions.cli_input.subprocess.run") as run, \
                         self.assertRaisesRegex(ValueError, "unsupported on this platform"):
                        capture_clipboard_image(hostile)
                    run.assert_not_called()
                    continue
                with mock.patch("xueness.bundled_plugins.sessions.cli_input.platform.system", return_value="Darwin"), \
                     mock.patch("xueness.bundled_plugins.sessions.cli_input.shutil.which", return_value="/usr/bin/osascript"), \
                     mock.patch("xueness.bundled_plugins.sessions.cli_input.subprocess.run", side_effect=fake_osascript):
                    attachment = capture_clipboard_image(hostile)
                script, path = captured["argv"][2], captured["argv"][3]
                self.assertEqual(script, _MACOS_CLIPBOARD_SCRIPT)
                self.assertNotIn(hostile.name, script)
                self.assertIn(hostile.name, path)
                self.assertEqual("image/png", attachment.mime_type)

    def test_unsupported_clipboard_platform_reports_without_capturing(self):
        with mock.patch("xueness.bundled_plugins.sessions.cli_input.platform.system", return_value="Windows"), \
             mock.patch("xueness.bundled_plugins.sessions.cli_input.subprocess.run") as run, \
             self.assertRaisesRegex(ValueError, "unsupported on this platform"):
            capture_clipboard_image(self.root)
        run.assert_not_called()

    def test_paste_image_is_explicit_and_never_prints_clipboard_bytes(self):
        from xueness.cli_input import Attachment
        raw = b"\x89PNG\r\n\x1a\nprivate clipboard image"
        attachment = Attachment("clipboard-image.png", "", len(raw), hashlib.sha256(raw).hexdigest(),
                                "image/png", __import__('base64').b64encode(raw).decode())
        with mock.patch("xueness.cli.capture_clipboard_image", return_value=attachment) as capture:
            code, out, err = self.chat("/paste-image\nlook at this\n/exit\n")
        self.assertEqual(0, code, err)
        capture.assert_called_once_with(self.root.resolve())
        self.assertNotIn(raw.decode("latin1"), out + err)
        self.assertNotIn(attachment.data_base64, out + err)
        with mock.patch("xueness.cli.capture_clipboard_image") as capture:
            self.chat("/exit\n")
        capture.assert_not_called()


if __name__ == "__main__":
    unittest.main()
