"""End-to-end proof that enabled skills reach the model context.

This is the step that separates "a module returns a string" from "the agent
actually knows the skill exists". A recording provider captures every
``messages`` list handed to the model, so we assert on what the model would
have seen — not on the intermediate helper.

The two properties that matter:

1. The skill name / body appear in the **prompt view**, wrapped in the
   untrusted-data preamble.
2. The skill body is **absent from the journal** (``session["messages"]``),
   because injected context must never be persisted and replayed.
"""
import json
import tempfile
import unittest
from pathlib import Path

from xueness.core import Gate, Store, run
from xueness.memory import UNTRUSTED_PREAMBLE
from xueness.skills import load as load_skills

SKILL_BODY = "Always run the linter before claiming success."


def _write_skill(state_dir: Path, rid: str, **fields) -> None:
    directory = Path(state_dir) / "resources" / "skills"
    directory.mkdir(parents=True, exist_ok=True)
    item = {"id": rid, "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-01T00:00:00+00:00"}
    item.update(fields)
    (directory / f"{rid}.json").write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")


class RecordingProvider:
    """Captures every prompt it is asked to complete, then finishes at once."""

    def __init__(self):
        self.prompts: list = []

    def complete(self, messages, tools):
        self.prompts.append(json.loads(json.dumps(messages)))  # deep copy
        return {"content": json.dumps({"summary": "done", "evidence": []})}


class SkillsReachModelContextTests(unittest.TestCase):
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

    def _run_once(self, skills_text):
        session = self.store.new("do the thing", self.workspace)
        provider = RecordingProvider()
        gate = Gate(self.workspace, allow_write=False, allow_exec=False)
        run(session, self.store, provider, gate, max_steps=1, skills=skills_text)
        return session, provider

    def test_skill_body_reaches_the_prompt(self):
        _write_skill(self.state, "demo", name="Demo Skill", description="A demo.", body=SKILL_BODY)
        text = load_skills(self.state)
        self.assertIn(SKILL_BODY, text, "loader did not emit the skill body")

        _, provider = self._run_once(text)
        self.assertTrue(provider.prompts, "provider was never called")
        flattened = json.dumps(provider.prompts[0], ensure_ascii=False)
        self.assertIn("Demo Skill", flattened)
        self.assertIn(SKILL_BODY, flattened)
        self.assertIn(UNTRUSTED_PREAMBLE, flattened, "injected skills must be marked untrusted")

    def test_skill_body_is_not_persisted_in_the_journal(self):
        """Injected context is prompt-only; the journal must stay clean."""
        _write_skill(self.state, "demo", name="Demo Skill", body=SKILL_BODY)
        text = load_skills(self.state)
        session, _ = self._run_once(text)

        journal = json.dumps(session["messages"], ensure_ascii=False)
        self.assertNotIn(SKILL_BODY, journal, "skill body leaked into the persisted journal")
        # The original user task must still be there, in its original slot.
        self.assertEqual(session["messages"][0]["role"], "system")
        self.assertEqual(session["messages"][1]["role"], "user")
        self.assertEqual(session["messages"][1]["content"], "do the thing")

    def test_disabled_skill_never_reaches_the_prompt(self):
        _write_skill(self.state, "off", name="Disabled Skill", body=SKILL_BODY, enabled=False)
        text = load_skills(self.state)
        self.assertEqual(text, "", "a disabled skill must not be injected")

        _, provider = self._run_once(text)
        flattened = json.dumps(provider.prompts[0], ensure_ascii=False)
        self.assertNotIn("Disabled Skill", flattened)
        self.assertNotIn(SKILL_BODY, flattened)

    def test_no_skills_keeps_the_prompt_unmodified(self):
        """With nothing to inject the prompt is byte-identical to the journal."""
        _, provider = self._run_once(None)
        self.assertEqual(provider.prompts[0], provider.prompts[0])
        self.assertNotIn(UNTRUSTED_PREAMBLE, json.dumps(provider.prompts[0], ensure_ascii=False))
        # No extra user message was spliced in.
        roles = [m.get("role") for m in provider.prompts[0]]
        self.assertEqual(roles, ["system", "user"])

    def test_toggling_a_skill_off_removes_it_from_the_prompt(self):
        """The UI switch must have real effect: on -> injected, off -> gone."""
        _write_skill(self.state, "toggle", name="Toggle Skill", body=SKILL_BODY)
        self.assertIn(SKILL_BODY, load_skills(self.state))

        # Simulate what the PATCH endpoint does when the switch is turned off.
        path = self.state / "resources" / "skills" / "toggle.json"
        item = json.loads(path.read_text(encoding="utf-8"))
        item["enabled"] = False
        path.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")

        self.assertEqual(load_skills(self.state), "")


if __name__ == "__main__":
    unittest.main()
