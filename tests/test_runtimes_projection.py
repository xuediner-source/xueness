"""Journal-to-v4 projection tests.

These tests exercise the source-of-truth boundary: rows and usage must come
from a journal-shaped session and a missing tool result must remain pending,
without a synthetic assistant answer being added by the adapter.
"""
import unittest

from xueness.bundled_plugins.runtimes.projection import (
    session_to_rows,
    session_to_snapshot,
)


def _session(status="completed"):
    return {
        "id": "a" * 32,
        "status": status,
        "messages": [
            {"role": "system", "content": "private", "_message_id": "1"},
            {"role": "user", "content": "read report", "_message_id": "2", "_turn_id": "turn-1"},
            {"role": "assistant", "content": "", "_message_id": "3", "_turn_id": "turn-1",
             "tool_calls": [{"id": "call-1", "function": {"name": "read_file", "arguments": "{\"path\":\"report.md\"}"}}]},
        ],
        "results": {},
        "provider_usage": [{"usage": {"prompt_tokens": 7, "completion_tokens": 3}}],
    }


class RuntimeProjectionTests(unittest.TestCase):
    def test_rows_are_stable_and_missing_tool_output_is_not_invented(self):
        session = _session("running")
        first = session_to_rows(session)
        second = session_to_rows(session)
        self.assertEqual(first, second)
        self.assertEqual([row["kind"] for row in first], ["userInput", "toolCall"])
        tool = first[-1]
        self.assertEqual(tool["status"], "running")
        self.assertNotIn("output", tool)
        self.assertNotIn("assistantText", [row["kind"] for row in first])

    def test_recorded_result_and_usage_are_projected_from_journal(self):
        session = _session()
        session["results"] = {"call-1": {"ok": True, "output": "report text"}}
        snapshot = session_to_snapshot(session, log_epoch="epoch-1", seq=4, revision=2)
        tool = snapshot["rows"]["window"][-1]
        self.assertEqual(tool["status"], "success")
        self.assertEqual(tool["output"]["text"], "report text")
        self.assertEqual(snapshot["usage"]["cumulative"]["inputTokens"], 7)
        self.assertEqual(snapshot["usage"]["cumulative"]["outputTokens"], 3)
        self.assertEqual(snapshot["control"]["phase"], "completedSuccess")
        self.assertEqual(snapshot["rows"]["totalCount"], 2)

    def test_error_and_interrupted_status_are_source_derived(self):
        session = _session("paused")
        session["results"] = {"call-1": {"ok": False, "error": "denied", "error_code": "policy_denied"}}
        rows = session_to_rows(session)
        self.assertEqual(rows[-1]["status"], "error")
        self.assertEqual(rows[-1]["error"]["code"], "tool.failed")
        snapshot = session_to_snapshot(session)
        self.assertEqual(snapshot["control"]["phase"], "completedInterrupted")

    def test_stream_replay_keeps_identity_and_never_duplicates_completed_text(self):
        session = _session("running")
        session["streaming"] = {"id": "stream-1", "text": "partial", "reasoning": "thinking", "status": "streaming"}
        live = session_to_snapshot(session)
        live_text = next(row for row in live["rows"]["window"] if row["kind"] == "assistantText")
        session["messages"].append({"role": "assistant", "content": "partial", "_message_id": "final-1", "_turn_id": "turn-1"})
        session["stream_history"] = [{**session.pop("streaming"), "status": "completed", "final_message_index": 3}]
        session["status"] = "completed"
        saved = session_to_snapshot(session)
        texts = [row for row in saved["rows"]["window"] if row["kind"] == "assistantText"]
        self.assertEqual(len(texts), 1)
        self.assertEqual(texts[0]["rowId"], live_text["rowId"])
        self.assertEqual(texts[0]["messageIndex"], 3)
        self.assertEqual(texts[0]["state"], "complete")
        self.assertEqual(saved["control"]["phase"], "completedSuccess")
        session["streaming"] = {"id": "stopped", "text": "received", "status": "interrupted"}
        session["status"] = "paused"
        self.assertEqual(session_to_snapshot(session)["control"]["phase"], "completedInterrupted")

    def test_approval_reasoning_and_completion_are_recorded_facts(self):
        session = _session("paused")
        session["results"] = {"call-1": {"ok": False, "error": "denied", "error_code": "approval_required"}}
        session["reasoning_history"] = [{"message_index": 2, "text": "Inspect the recorded report."}]
        session["completion"] = {"turn_id": "turn-1", "status": "incomplete", "verified": False, "summary": "Approval required."}
        snapshot = session_to_snapshot(session)
        self.assertEqual([row["kind"] for row in snapshot["rows"]["window"]], ["userInput", "reasoning", "toolCall"])
        self.assertEqual(snapshot["rows"]["window"][-1]["status"], "pendingApproval")
        self.assertEqual(snapshot["meta"]["outcomes"][0]["summary"], "Approval required.")
        self.assertEqual(snapshot["meta"]["rowOrder"], [row["rowId"] for row in snapshot["rows"]["window"]])


if __name__ == "__main__":
    unittest.main()
