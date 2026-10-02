"""Every declared hook event must actually fire.

Found during a parity re-review: ``UserPromptSubmit`` and ``PermissionRequest``
were listed in ``HOOK_EVENTS`` and validated on load, but the run loop never
fired them. The existing test only asserted the constant, so a hook configured
for either event was accepted, persisted, shown as enabled, and then silently
never ran -- worse than a missing feature, because it looks supported.

These tests drive the real run loop with a hook per event and assert on the
marker file each hook writes, so a future change that drops an event fails here
instead of shipping a dead hook.
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from xueness.core import Gate, Store, run
from xueness.hooks import HOOK_EVENTS, HookRunner, load as load_hooks

MARKER_WRITER = "open(%r,'a').write(%r+'\\n')"


class _ScriptedProvider:
    """Replays a fixed list of tool calls, then finishes."""

    def __init__(self, calls):
        self.calls = list(calls)
        self.n = 0

    def complete(self, messages, tools):
        if self.n < len(self.calls):
            call = self.calls[self.n]
            self.n += 1
            return {"content": "", "tool_calls": [call]}
        return {"content": json.dumps({"summary": "done", "evidence": []})}


def _call(call_id, name, **args):
    return {"id": call_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}}


class EveryEventFiresTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        base = Path(holder.name)
        self.state = base / "state"
        self.workspace = base / "ws"
        self.state.mkdir(parents=True)
        self.workspace.mkdir(parents=True)
        self.marker = self.state / "fired.txt"
        self.store = Store(self.state)

        hooks_dir = self.state / "resources" / "hooks"
        hooks_dir.mkdir(parents=True)
        for event in HOOK_EVENTS:
            (hooks_dir / ("%s.json" % event)).write_text(json.dumps({
                "id": event, "event": event, "enabled": True,
                "command": sys.executable,
                "args": ["-c", MARKER_WRITER % (str(self.marker), event)],
            }), encoding="utf-8")

    def _fired(self):
        if not self.marker.exists():
            return []
        return [line for line in self.marker.read_text(encoding="utf-8").splitlines() if line]

    def _run(self, provider, gate=None):
        session = self.store.new("probe every event", self.workspace)
        return run(session, self.store, provider, gate or Gate(self.workspace),
                   max_steps=8, hooks=HookRunner(load_hooks(self.state), self.workspace))

    def test_all_seven_events_fire_in_one_turn(self):
        """A failed call, successful call, then denied call all fire their hooks."""
        (self.workspace / "ok.txt").write_text("hello", encoding="utf-8")
        provider = _ScriptedProvider([
            _call("c1", "read", path="nope.txt"),              # fails -> PostToolUseFailure
            _call("c2", "read", path="ok.txt"),                # succeeds -> PostToolUse
            _call("c3", "write", path="a.txt", content="x"),   # denied -> PermissionRequest
        ])
        self._run(provider)

        fired = set(self._fired())
        self.assertEqual(fired, set(HOOK_EVENTS),
                         "missing: %s" % sorted(set(HOOK_EVENTS) - fired))

    def test_user_prompt_submit_sees_the_turn_text(self):
        """The event must carry the prompt, not just fire for its own sake."""
        captured = self.state / "prompt.txt"
        hook = self.state / "resources" / "hooks" / "UserPromptSubmit.json"
        hook.write_text(json.dumps({
            "id": "UserPromptSubmit", "event": "UserPromptSubmit", "enabled": True,
            "command": sys.executable,
            "args": ["-c",
                     "import json,sys; d=json.load(sys.stdin); "
                     "open(%r,'w').write(d.get('prompt') or '')" % str(captured)],
        }), encoding="utf-8")

        provider = _ScriptedProvider([])
        self._run(provider)
        self.assertTrue(captured.exists(), "UserPromptSubmit hook never ran")
        self.assertIn("probe every event", captured.read_text(encoding="utf-8"))

    def test_permission_request_is_observational_not_an_approval(self):
        """A PermissionRequest hook exiting 2 must NOT grant the denied call.

        If a hook could approve, it would silently defeat the gate it observes:
        the whole point of the gate is that a human decides.
        """
        (self.workspace / "ok.txt")
        hook = self.state / "resources" / "hooks" / "PermissionRequest.json"
        # Writes the marker AND exits 2 (the "block" code for PreToolUse); here
        # the exit code must be inert -- observation, never an approval.
        hook.write_text(json.dumps({
            "id": "PermissionRequest", "event": "PermissionRequest", "enabled": True,
            "command": sys.executable,
            "args": ["-c",
                     (MARKER_WRITER + ";import sys;sys.exit(2)")
                     % (str(self.marker), "PermissionRequest")],
        }), encoding="utf-8")

        provider = _ScriptedProvider([_call("c1", "write", path="a.txt", content="x")])
        session = self.store.new("probe approval semantics", self.workspace)
        out = run(session, self.store, provider, Gate(self.workspace), max_steps=4,
                  hooks=HookRunner(load_hooks(self.state), self.workspace))

        result = out["results"].get("c1", {})
        self.assertEqual(result.get("error"), "denied",
                         "an observing hook must not become an approver")
        self.assertFalse((self.workspace / "a.txt").exists())
        self.assertIn("PermissionRequest", self._fired())

    def test_hooks_none_fires_nothing(self):
        provider = _ScriptedProvider([_call("c1", "read", path="ok.txt")])
        (self.workspace / "ok.txt").write_text("hi", encoding="utf-8")
        session = self.store.new("no hooks", self.workspace)
        run(session, self.store, provider, Gate(self.workspace), max_steps=4, hooks=None)
        self.assertEqual(self._fired(), [])


if __name__ == "__main__":
    unittest.main()
