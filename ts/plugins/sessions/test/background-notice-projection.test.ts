import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { it } from "node:test";
import { conversationSnapshot } from "../src/conversation-api.ts";
import { eventsPage, journalPage } from "../src/journal-http.ts";
import { legacyEvents } from "../src/legacy-events.ts";
import { resumePage } from "../src/event-resume.ts";
import { displayRows } from "../src/snapshot-rows.ts";
import { FullscreenChatTerminal } from "../src/tui.ts";

type Row = Record<string, any>;

it("projects background notices as system activity without changing journal or ordinary inputs", async () => {
  const sid = "a".repeat(32);
  const notice = {
    role: "user", content: "Background task done: task-1 (exited)",
    _input_kind: "background_notice", _meta_source: "task_status", _background_task_notice: "task-1:exited",
  };
  const session: Row = {
    id: sid, status: "completed", steps: 1, task: "Initial task", root: process.cwd(), results: {},
    messages: [
      { role: "system", content: "System context" },
      { role: "user", content: "Initial task" },
      notice,
      { role: "user", content: "Guide instruction", _input_kind: "guide" },
      { role: "user", content: "Human follow-up" },
    ],
  };
  const before = structuredClone(session);

  assert.deepEqual(displayRows(session as never).map(([message, index]) => [(message as Row).content, index]), [
    ["System context", 0], ["Initial task", 1], ["Guide instruction", 3], ["Human follow-up", 4],
  ]);
  const journal = journalPage(session as never, {});
  assert.deepEqual((journal.messages as Row[]).map((message) => message.content), ["System context", "Initial task", "Guide instruction", "Human follow-up"]);
  assert.equal(journal.total_messages, 4);
  const archivedSession = { ...session, archived_messages: [notice] }, archivedBefore = structuredClone(archivedSession);
  assert.deepEqual((journalPage(archivedSession as never, {}).archived_messages as Row[]), []);
  assert.ok(!displayRows(archivedSession as never).some(([message]) => (message as Row).content === notice.content));
  assert.deepEqual(archivedSession, archivedBefore);

  const legacy = legacyEvents(session);
  assert.deepEqual(legacy.filter((event) => event.type === "runtime_activity").map((event) => event.message), [notice.content]);
  assert.deepEqual(legacy.filter((event) => event.type === "user").map((event) => event.preview), ["Guide instruction", "Human follow-up"]);
  for (const envelope of [eventsPage(session as never, {})[1], resumePage(session, null, 50, "replayable")]) {
    const userEvents = (envelope as Row).events.filter((event: Row) => event.type === "turn.user");
    assert.ok(!userEvents.some((event: Row) => event.preview === notice.content));
    assert.ok(userEvents.some((event: Row) => event.preview === "Human follow-up"));
  }

  const snapshot = await conversationSnapshot({
    store: { load: async () => session }, enabled: () => true, running: new Set(),
  } as never, sid, null, null, (saved) => ({ id: saved.id }));
  assert.deepEqual((snapshot.journal as Row).messages.map((message: Row) => message.content), ["System context", "Initial task", "Guide instruction", "Human follow-up"]);
  assert.ok(!(snapshot.timeline as Row).events.some((event: Row) => event.type === "turn.user" && event.preview === notice.content));

  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const terminal = new FullscreenChatTerminal({ input: input as never, output: output as never, language: "en" });
  try {
    terminal.history(session.messages);
    assert.deepEqual(terminal.ui.document.entries.map((entry) => [entry.kind, entry.text]), [
      ["user", "Initial task"], ["user", "Guide instruction"], ["user", "Human follow-up"],
    ]);
    assert.deepEqual(terminal.ui.draft.history, ["Initial task", "Guide instruction", "Human follow-up"]);
  } finally { terminal.close(); }

  assert.deepEqual(session, before);
});
