"""Opt-in reasoning stream capture stays separate from model conversation history."""
import tempfile
import unittest
from pathlib import Path

from xueness.core import Gate, Store, run, compact
from xueness.bundled_plugins.settings.settings_store import update_settings


class ReasoningStreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root = base / "workspace"
        self.root.mkdir()
        self.store = Store(base / "state")

    def test_enabled_reasoning_is_bounded_and_attached_to_completed_assistant_message(self):
        class Provider:
            def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
                if on_reasoning_delta:
                    on_reasoning_delta("private thought")
                if on_delta:
                    on_delta("public answer")
                return {"content": "public answer", "tool_calls": []}

        session = self.store.new("answer", self.root)
        result = run(session, self.store, Provider(), Gate(self.root), max_steps=1,
                     policy_state_dir=self.store.directory)
        self.assertEqual(result["messages"][-1]["content"], "public answer")
        self.assertEqual(result["reasoning_history"], [
            {"message_index": len(result["messages"]) - 1, "text": "private thought"},
        ])
        self.assertNotIn("reasoning", result["messages"][-1])
        # The reasoning side channel must never be included in the next model context.
        self.assertNotIn("private thought", str(result["messages"]))

    def test_disabled_reasoning_preference_does_not_pass_capture_callback(self):
        update_settings(self.store.directory,
                        lambda settings: settings.__setitem__("general", {
                            "messageStreamShowReasoning": False,
                        }))

        class Provider:
            callback_was_given = None

            def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
                self.callback_was_given = on_reasoning_delta is not None
                if on_reasoning_delta:
                    on_reasoning_delta("must not be captured")
                return {"content": "answer", "tool_calls": []}

        provider = Provider()
        result = run(self.store.new("answer", self.root), self.store, provider,
                     Gate(self.root), max_steps=1, policy_state_dir=self.store.directory)
        self.assertFalse(provider.callback_was_given)
        self.assertNotIn("reasoning_history", result)

    def test_reasoning_only_stream_honors_stop_and_bounds_capture(self):
        stopping = [False]
        class Provider:
            def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
                on_reasoning_delta("x" * 40_000)
                stopping[0] = True
                on_reasoning_delta("later")
                raise AssertionError("stopped reasoning must interrupt the provider")
        result = run(self.store.new("answer", self.root), self.store, Provider(),
                     Gate(self.root), max_steps=1, should_stop=lambda: stopping[0])
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(len(result['streaming']['reasoning']), 32_000)
        self.assertTrue(result['streaming']['interrupted'])
        self.assertNotIn('reasoning_history', result)

    def test_compaction_reindexes_only_retained_assistant_reasoning(self):
        session = self.store.new("answer", self.root)
        for turn in range(12):
            session['messages'].extend([{'role':'user','content':'question ' + 'q'*400},
                                        {'role':'assistant','content':f'answer-{turn} ' + 'a'*400}])
            session.setdefault('reasoning_history', []).append({'message_index':len(session['messages'])-1, 'text':f'thought-{turn}'})
        compact(session, 1500)
        self.assertLess(len(session['reasoning_history']), 12)
        for item in session['reasoning_history']:
            turn = item['text'].split('-')[-1]
            self.assertTrue(session['messages'][item['message_index']]['content'].startswith(f'answer-{turn} '))


if __name__ == "__main__":
    unittest.main()
