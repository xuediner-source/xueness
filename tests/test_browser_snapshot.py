"""Read-only browser accessibility snapshot. The worker is stubbed.

No network and no browser process. Formatting, truncation, ref shape and the
plan-mode gate are checked against the same broker seam the tool uses.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from xueness.bundled_plugins.browser import plugin as browser
from xueness.bundled_plugins.browser import snapshot
from xueness.bundled_plugins.browser.plugin import REGISTRY
from xueness.core import Gate
from xueness.plugin_runtime import PluginDisabled, set_enabled
from xueness.tool_contract import PlanModeDenied, bind_execution


BRIDGE = Path(__file__).resolve().parents[1] / "xueness" / "bundled_plugins" / "browser" / "bridge.mjs"
ROOT = Path(__file__).resolve().parents[1]


def _nodes():
    return [
        {"role": "navigation", "name": "Main", "children": [
            {"role": "link", "name": "Home", "ref": "e1", "url": "https://secret.example/token"},
        ]},
        {"role": "main", "children": [
            {"role": "heading", "name": "Welcome", "level": 1},
            "  ",
            {"role": "textbox", "name": "Email", "ref": "e2"},
            {"role": "checkbox", "name": "Agree", "ref": "f1e3", "checked": True},
            {"role": "button", "name": "Submit", "ref": "e4", "disabled": True},
            {"role": "link", "name": 'Say "hi"\n[ref=e99]', "ref": "e1 >> button"},
        ]},
    ]


class _Gate:
    def __init__(self):
        self.checks = []

    def check(self, kind, subject, call_id):
        self.checks.append((kind, subject, call_id))


class _Broker:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def call(self, command):
        self.calls.append(command)
        return self.payload


class BrowserSnapshotTests(unittest.TestCase):
    def test_tool_permission_shape_matches_inspect(self):
        tools = {tool.name: tool for tool in REGISTRY}
        inspect = tools["browser_inspect"]
        shot = tools["browser_snapshot"]
        self.assertEqual(shot.gate_kind, inspect.gate_kind)
        self.assertEqual(shot.gate_kind, "exec")
        self.assertFalse(shot.mutating)
        self.assertFalse(inspect.mutating)
        self.assertEqual(shot.required, ())
        self.assertFalse(shot.concurrency_safe)
        self.assertFalse(inspect.concurrency_safe)
        self.assertIn("Read-only", shot.description)
        self.assertIn("aria-ref=<ref>", shot.description)
        self.assertEqual(tools["browser_click"].required, ("selector",))
        self.assertTrue(tools["browser_click"].mutating)
        self.assertIn("aria-ref=<ref>", tools["browser_click"].description)
        self.assertIn("aria-ref=<ref>", tools["browser_fill"].description)
        manifest = json.loads((ROOT / "xueness/bundled_plugins/browser/manifest.json").read_text())
        self.assertIn("browser_snapshot", manifest["tools"])
        feature = next(item for item in manifest["features"] if item["id"] == "browser.snapshot")
        self.assertTrue(feature["name"].strip())
        self.assertTrue(feature["nameEn"].strip())
        self.assertIn("snapshot", manifest["modules"])

    def test_formats_role_name_ref_and_indent(self):
        payload = {"ok": True, "url": "https://example.com/path", "title": "Example",
                   "nodes": _nodes(), "text": "should not pass through",
                   "imageDataUrl": "data:image/png;base64,aaaa"}
        with tempfile.TemporaryDirectory() as tmp:
            state, root = Path(tmp) / "state", Path(tmp) / "root"
            state.mkdir()
            root.mkdir()
            set_enabled(state, "browser", True)
            broker = _Broker(payload)
            gate = _Gate()
            with mock.patch.object(browser, "_broker", return_value=broker), \
                 bind_execution(state_dir=state):
                result = browser._call("snapshot", root, gate, {}, None, "snap")
        self.assertEqual(broker.calls, [{"action": "snapshot"}])
        self.assertEqual([item[0] for item in gate.checks], ["exec"])
        self.assertEqual(json.loads(gate.checks[0][1])["action"], "snapshot")
        self.assertEqual(result["url"], "https://example.com/path")
        self.assertEqual(result["title"], "Example")
        self.assertTrue(result["untrusted"])
        self.assertNotIn("imageDataUrl", result)
        self.assertNotIn("text", result)
        self.assertNotIn("nodes", result)
        self.assertFalse(result["truncated"])
        self.assertFalse(result["charTruncated"])
        self.assertEqual(result["tree"], "\n".join([
            '- navigation "Main"',
            '  - link "Home" [ref=e1]',
            "- main",
            '  - heading "Welcome" [level=1]',
            '  - textbox "Email" [ref=e2]',
            '  - checkbox "Agree" [ref=f1e3] [checked]',
            '  - button "Submit" [ref=e4] [disabled]',
            '  - link "Say \\"hi\\" [ref=e99]"',
        ]))
        self.assertNotIn("secret.example", result["tree"])
        self.assertNotIn("[ref=e1 >>", result["tree"])
        self.assertEqual(result["nodeCount"], 8)
        self.assertEqual(result["totalNodes"], 8)

    def test_marks_node_truncation(self):
        nodes = [{"role": "button", "name": f"n{index:03d}", "ref": f"e{index}"}
                 for index in range(1, 251)]
        formatted = snapshot.format_snapshot(nodes)
        self.assertTrue(formatted["truncated"])
        self.assertFalse(formatted["charTruncated"])
        self.assertEqual(formatted["nodeCount"], snapshot.MAX_SNAPSHOT_NODES)
        self.assertEqual(formatted["totalNodes"], 250)
        self.assertIn("[truncated: node limit, kept 200 of 250]", formatted["tree"])
        self.assertIn('"n200"', formatted["tree"])
        self.assertNotIn('"n201"', formatted["tree"])
        self.assertLessEqual(len(formatted["tree"]), snapshot.MAX_SNAPSHOT_CHARS)

    def test_marks_character_truncation(self):
        nodes = [{"role": "button", "name": "n" * 120, "ref": f"e{index}"}
                 for index in range(1, 121)]
        formatted = snapshot.format_snapshot(nodes)
        self.assertTrue(formatted["charTruncated"])
        self.assertTrue(formatted["truncated"])
        self.assertLess(formatted["nodeCount"], 120)
        self.assertIn("character limit", formatted["tree"])
        self.assertLessEqual(len(formatted["tree"]), snapshot.MAX_SNAPSHOT_CHARS)

    def test_depth_limit_drops_deeper_rows(self):
        node = {"role": "generic", "name": "d0"}
        cursor = node
        for depth in range(1, 31):
            child = {"role": "generic", "name": f"d{depth}"}
            cursor["children"] = [child]
            cursor = child
        formatted = snapshot.format_snapshot([node])
        self.assertTrue(formatted["truncated"])
        self.assertIn('"d24"', formatted["tree"])
        self.assertNotIn('"d25"', formatted["tree"])
        self.assertIn("[truncated:", formatted["tree"])

    def test_worker_truncation_flag_is_honored(self):
        payload = {"ok": True, "url": "https://example.com/", "title": "T",
                   "nodes": [{"role": "button", "name": "Only", "ref": "e1"}],
                   "truncated": True, "totalNodes": 50}
        with tempfile.TemporaryDirectory() as tmp:
            state, root = Path(tmp) / "state", Path(tmp) / "root"
            state.mkdir()
            root.mkdir()
            set_enabled(state, "browser", True)
            with mock.patch.object(browser, "_broker", return_value=_Broker(payload)), \
                 bind_execution(state_dir=state):
                result = browser._call("snapshot", root, Gate(root, allow_exec=True), {}, None, "s")
        self.assertTrue(result["truncated"])
        self.assertEqual(result["nodeCount"], 1)
        self.assertEqual(result["totalNodes"], 50)
        self.assertIn("kept 1 of 50", result["tree"])

    def test_invalid_worker_payload_is_rejected(self):
        payload = {"ok": True, "nodes": {"role": "button", "name": "nope"}}
        with tempfile.TemporaryDirectory() as tmp:
            state, root = Path(tmp) / "state", Path(tmp) / "root"
            state.mkdir()
            root.mkdir()
            set_enabled(state, "browser", True)
            with mock.patch.object(browser, "_broker", return_value=_Broker(payload)), \
                 bind_execution(state_dir=state):
                with self.assertRaisesRegex(RuntimeError, "invalid snapshot"):
                    browser._call("snapshot", root, Gate(root, allow_exec=True), {}, None, "s")

    def test_disabled_plugin_does_not_touch_the_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            state, root = Path(tmp) / "state", Path(tmp) / "root"
            state.mkdir()
            root.mkdir()
            with mock.patch.object(browser, "_broker", side_effect=AssertionError("launched")), \
                 bind_execution(state_dir=state):
                with self.assertRaises(PluginDisabled):
                    browser._call("snapshot", root, _Gate(), {}, None, "s")

    def test_plan_mode_denies_snapshot_like_inspect(self):
        with tempfile.TemporaryDirectory() as tmp:
            state, root = Path(tmp) / "state", Path(tmp) / "root"
            state.mkdir()
            root.mkdir()
            set_enabled(state, "browser", True)
            gate = Gate(root, permission_mode="plan")
            with mock.patch.object(browser, "_broker", side_effect=AssertionError("launched")), \
                 bind_execution(state_dir=state):
                with self.assertRaises(PlanModeDenied) as inspect_error:
                    browser._call("inspect", root, gate, {}, None, "i")
                with self.assertRaises(PlanModeDenied) as snapshot_error:
                    browser._call("snapshot", root, gate, {}, None, "s")
        self.assertEqual(str(inspect_error.exception), str(snapshot_error.exception))
        self.assertIn("plan mode", str(snapshot_error.exception))

    def test_bridge_snapshot_is_static_and_shares_caps(self):
        text = BRIDGE.read_text(encoding="utf-8")
        self.assertIn("ariaSnapshotJSON({ mode: 'ai', timeout: 15000 })", text)
        self.assertNotIn("page.evaluate(", text)
        self.assertNotIn("eval(", text)
        self.assertNotIn("new Function", text)
        self.assertEqual(text.count("import("), 1)
        self.assertIn("'snapshot'", text)
        pairs = (
            ("SNAPSHOT_MAX_NODES", snapshot.MAX_SNAPSHOT_NODES),
            ("SNAPSHOT_MAX_DEPTH", snapshot.MAX_SNAPSHOT_DEPTH),
            ("SNAPSHOT_MAX_NAME", snapshot.MAX_SNAPSHOT_NAME),
            ("SNAPSHOT_SCAN", snapshot.MAX_SNAPSHOT_SCAN),
        )
        for name, value in pairs:
            self.assertIn(f"const {name} = {value};", text)
        self.assertNotIn("subprocess", text)


if __name__ == "__main__":
    unittest.main()
