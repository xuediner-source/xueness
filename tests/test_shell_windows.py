"""Desktop shell compatibility without loosening the execution gate."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from xueness.core import Gate
from xueness import process_runtime
from xueness.bundled_plugins.shell import tooling


class ShellDesktopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def execute(self, argv):
        return tooling._exec(self.root, Gate(self.root, allow_exec=True), {"argv": argv}, None, "exact")

    def test_gate_is_checked_before_any_process_launch(self):
        with patch.object(process_runtime, "run_external") as run:
            with self.assertRaises(PermissionError):
                tooling._exec(self.root, Gate(self.root), {"argv": ["missing"]}, None, "exact")
        run.assert_not_called()

    def test_missing_executable_and_timeout_are_actionable_results(self):
        for error, code in ((FileNotFoundError(), "command_not_found"),
                            (subprocess.TimeoutExpired(["test"], 30), "command_timeout")):
            with patch.object(process_runtime, "run_external", side_effect=error):
                result = self.execute(["test"])
            self.assertFalse(result["ok"])
            self.assertEqual(result["error_code"], code)
            self.assertFalse(result["retryable"])

    def test_utf8_bom_and_utf16_preserve_chinese_output(self):
        for encoding in ("utf-8", "utf-8-sig", "utf-16"):
            self.assertEqual(tooling._decode_output("本机输出".encode(encoding)), "本机输出")

    @unittest.skipUnless(os.name == "nt", "Windows console encoding")
    def test_windows_console_command_uses_utf8_and_hides_children(self):
        import ctypes
        cp = f'cp{ctypes.windll.kernel32.GetOEMCP()}'
        # Captured pipes are UTF-8 on every host. An OEM code page is not a
        # second decoder; a console that is already UTF-8 still round-trips.
        raw = "本机输出".encode(cp)
        decoded = tooling._decode_output(raw)
        if cp.lower() in ("utf-8", "utf8", "cp65001"):
            self.assertEqual(decoded, "本机输出")
        else:
            self.assertNotEqual(decoded, "本机输出")
            self.assertIn("\ufffd", decoded)
        with patch.object(process_runtime, "run_external", wraps=process_runtime.run_external) as run:
            result = self.execute(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                                   "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Write-Output '本机输出'"])
        self.assertTrue(result["ok"], result)
        self.assertIn("本机输出", result["output"])
        self.assertEqual(run.call_args.kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)
        self.assertFalse(run.call_args.kwargs["shell"])
        self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertIn("Host OS: Windows", tooling._description())
