"""End-to-end proof that hooks actually gate and observe tool calls.

The unit tests prove ``HookRunner`` behaves; these prove the *loop* honours it:

1. A ``PreToolUse`` hook exiting 2 really stops the tool from running
   (no artifact on disk) and the journal records the block.
2. A ``PreToolUse`` hook exiting 0 lets the tool run.
3. ``PostToolUse`` fires after a successful call.
4. The session hook log carries metadata only — never hook stdout.
5. ``hooks=None`` spawns no subprocess at all.

The hooks are real subprocesses (``sys.executable -c ...``), so a passing run
is evidence the wiring works, not just that a mock was consulted.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

from xueness.core import Gate, Store, run
from xueness.hooks import HookRunner


def _write_hook(state_dir: Path, rid: str, **fields) -> None:
    directory = Path(state_dir) / "resources" / "hooks"
    directory.mkdir(parents=True, exist_ok=True)
    item = {"id": rid, "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-01T00:00:00+00:00", "enabled": True,
            "type": "command", "command": sys.executable}
    item.update(fields)
    (directory / f"{rid}.json").write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")


def _py(code: str) -> list:
    """argv for a one-liner python subprocess."""
    return [sys.executable, "-c", code]


class WriteToolProvider:
    """Emits exactly one write tool call, then finishes on the next turn."""

    def __init__(self, path="artifact.txt"):
        self.path = path
        self.calls = 0

    def complete(self, messages, tools):
        self.calls += 1
        if self.calls == 1:
            return {"content": "", "tool_calls": [
                {"id": "call-1", "type": "function",
                 "function": {"name": "write",
                              "arguments": json.dumps({"path": self.path, "content": "made\n"})}},
            ]}
        return {"content": json.dumps({"summary": "done", "evidence": []})}


class HookLoopIntegrationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        self.state = self.base / "state"
        self.workspace = self.base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.store = Store(self.state)

    def tearDown(self):
        self._tmp.cleanup()

    def _runner(self, hooks):
        return HookRunner(hooks, self.workspace)

    def test_pre_tool_use_exit_2_blocks_the_tool(self):
        sentinel = self.base / "ran.txt"
        _write_hook(
            self.state, "blocker", event="PreToolUse", matcher="write",
            args=["-c", f"import sys; open({str(sentinel)!r},'w').write('x'); sys.exit(2)"],
            command=sys.executable,
        )
        from xueness.hooks import load as load_hooks

        session = self.store.new("write a file", self.workspace)
        provider = WriteToolProvider()
        gate = Gate(self.workspace, allow_write=True)
        out = run(session, self.store, provider, gate, max_steps=3,
                  hooks=self._runner(load_hooks(self.state)))

        # The hook itself ran...
        self.assertTrue(sentinel.exists(), "PreToolUse hook never executed")
        # ...and the tool did NOT.
        self.assertFalse((self.workspace / "artifact.txt").exists(),
                         "tool ran despite the PreToolUse hook exiting 2")

        journal = json.dumps(session["messages"], ensure_ascii=False)
        self.assertIn("hook_blocked", journal)
        self.assertTrue(any(e.get("blocked") for e in out.get("hook_log", [])),
                        "session hook log recorded no block")

    def test_pre_tool_use_exit_0_allows_the_tool(self):
        _write_hook(self.state, "allow", event="PreToolUse", matcher="write",
                    args=["-c", "import sys; sys.exit(0)"], command=sys.executable)
        from xueness.hooks import load as load_hooks

        session = self.store.new("write a file", self.workspace)
        provider = WriteToolProvider()
        gate = Gate(self.workspace, allow_write=True)
        run(session, self.store, provider, gate, max_steps=3,
            hooks=self._runner(load_hooks(self.state)))

        self.assertTrue((self.workspace / "artifact.txt").exists(),
                        "tool was blocked even though the hook exited 0")

    def test_post_tool_use_fires_after_success(self):
        sentinel = self.base / "post-ran.txt"
        _write_hook(self.state, "observer", event="PostToolUse", matcher="write",
                    args=["-c", f"open({str(sentinel)!r},'w').write('x')"],
                    command=sys.executable)
        from xueness.hooks import load as load_hooks

        session = self.store.new("write a file", self.workspace)
        provider = WriteToolProvider()
        gate = Gate(self.workspace, allow_write=True)
        run(session, self.store, provider, gate, max_steps=3,
            hooks=self._runner(load_hooks(self.state)))

        self.assertTrue(sentinel.exists(), "PostToolUse hook never fired")
        self.assertTrue((self.workspace / "artifact.txt").exists())

    def test_block_reason_does_not_smuggle_hook_stdout_into_the_journal(self):
        """A hook's stdout is untrusted and must not be replayed as model context.

        The block path used to splice the hook's stdout straight into the tool
        result's ``error`` string, which lands in the journal and becomes model
        context on the next turn — and it skipped the output cap entirely.
        The error must name the hook; the text goes in a field that says what it
        is, clipped.
        """
        long_line = "X" * 900
        _write_hook(self.state, "noisy-blocker", event="PreToolUse", matcher="write",
                    args=["-c", "import sys; print(%r); sys.exit(2)" % long_line],
                    command=sys.executable)
        from xueness.hooks import load as load_hooks

        session = self.store.new("write a file", self.workspace)
        provider = WriteToolProvider()
        gate = Gate(self.workspace, allow_write=True)
        run(session, self.store, provider, gate, max_steps=3,
            hooks=self._runner(load_hooks(self.state)))

        result = session["results"].get("call-1") or {}
        self.assertTrue(result.get("hook_blocked"))
        # The machine-readable error names the hook, not the hook's output.
        self.assertIn("noisy-blocker", result.get("error", ""))
        self.assertNotIn(long_line, result.get("error", ""))
        # The untrusted text is present but clipped and clearly labelled.
        text = result.get("hook_output_untrusted", "")
        self.assertTrue(text, "the block reason should still be available")
        self.assertLessEqual(len(text), 500 + len("\n…(truncated)"))

    def test_hook_log_never_contains_hook_stdout(self):
        """Hook output is untrusted; only metadata may be persisted."""
        secret = "HOOK_STDOUT_SECRET_31337"
        _write_hook(self.state, "noisy", event="PostToolUse", matcher="write",
                    args=["-c", f"print({secret!r})"], command=sys.executable)
        from xueness.hooks import load as load_hooks

        session = self.store.new("write a file", self.workspace)
        provider = WriteToolProvider()
        gate = Gate(self.workspace, allow_write=True)
        out = run(session, self.store, provider, gate, max_steps=3,
                  hooks=self._runner(load_hooks(self.state)))

        logged = json.dumps(out.get("hook_log", []), ensure_ascii=False)
        self.assertTrue(out.get("hook_log"), "no hook log entries were written")
        self.assertNotIn(secret, logged, "hook stdout leaked into the session hook log")
        self.assertNotIn(secret, json.dumps(session["messages"], ensure_ascii=False))

    def test_hooks_none_spawns_no_subprocess(self):
        sentinel = self.base / "should-not-run.txt"
        _write_hook(self.state, "unused", event="PreToolUse", matcher="write",
                    args=["-c", f"open({str(sentinel)!r},'w').write('x')"],
                    command=sys.executable)
        from xueness.hooks import load as load_hooks

        session = self.store.new("write a file", self.workspace)
        provider = WriteToolProvider()
        gate = Gate(self.workspace, allow_write=True)
        out = run(session, self.store, provider, gate, max_steps=3, hooks=None)

        self.assertFalse(sentinel.exists(), "a hook ran even though hooks=None")
        self.assertFalse(out.get("hook_log"), "hooks=None still produced a hook log")
        self.assertTrue((self.workspace / "artifact.txt").exists())

    def test_stop_hook_fires_once(self):
        sentinel = self.base / "stop-count.txt"
        _write_hook(self.state, "stopper", event="Stop",
                    args=["-c",
                          f"import os; p={str(sentinel)!r}; "
                          f"n=int(open(p).read())+1 if os.path.exists(p) else 1; "
                          f"open(p,'w').write(str(n))"],
                    command=sys.executable)
        from xueness.hooks import load as load_hooks

        session = self.store.new("write a file", self.workspace)
        provider = WriteToolProvider()
        gate = Gate(self.workspace, allow_write=True)
        run(session, self.store, provider, gate, max_steps=3,
            hooks=self._runner(load_hooks(self.state)))

        self.assertEqual(sentinel.read_text(), "1", "Stop hook did not fire exactly once")

    def test_disabled_hook_is_not_executed(self):
        sentinel = self.base / "disabled-ran.txt"
        _write_hook(self.state, "offhook", event="PreToolUse", matcher="write",
                    enabled=False,
                    args=["-c", f"open({str(sentinel)!r},'w').write('x')"],
                    command=sys.executable)
        from xueness.hooks import load as load_hooks

        hooks = load_hooks(self.state)
        self.assertEqual(hooks, [], "a disabled hook was loaded")
        self.assertFalse(sentinel.exists())


if __name__ == "__main__":
    unittest.main()
