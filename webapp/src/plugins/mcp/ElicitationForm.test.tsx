import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ElicitationForm,
  ElicitationPendingTracker,
  McpElicitation,
  RESOLVED_ELICITATION_LIMIT,
  handleElicitationAction,
  parsePending,
  parsePendingSnapshot,
  validateElicitationContent,
  shouldDismissElicitationOnEscape,
  type ElicitationPending,
  type ElicitationSubmission,
} from "./ElicitationForm";

const pending: ElicitationPending = {
  id: 7,
  serverId: "docs",
  serverName: "Docs",
  message: "Need a few details",
  expiresAt: 1_800_000_000,
  requestedSchema: {
    type: "object",
    required: ["name", "count", "agree", "color"],
    properties: {
      name: { type: "string", title: "Name", minLength: 1, maxLength: 20 },
      count: { type: "integer", title: "Count", minimum: 0, maximum: 10 },
      ratio: { type: "number", title: "Ratio", minimum: 0, maximum: 1 },
      agree: { type: "boolean", title: "Agree" },
      color: { type: "string", title: "Color", enum: ["red", "blue"], enumNames: ["Red", "Blue"] },
      when: { type: "string", title: "When", format: "date" },
    },
  },
};

test("elicitation form renders text, number, switch, and select controls", () => {
  const html = renderToStaticMarkup(
    <ElicitationForm pending={pending} values={{ agree: true, color: "red" }} error="这一项不符合要求" errorField="count" onChange={() => undefined} onResolve={() => undefined} />,
  );
  assert.match(html, /data-testid="mcp-elicitation"/);
  assert.match(html, /aria-labelledby="xn-mcp-elicitation-title"/);
  assert.match(html, /type="text"/);
  assert.match(html, /inputMode="decimal"/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /<select/);
  assert.match(html, />Red</);
  assert.match(html, /Docs/);
  assert.match(html, /不要在这里填写密码或密钥。/);
  assert.match(html, /role="note"/);
  assert.match(html, /role="alert"/);
  assert.match(html, />提交</);
  assert.match(html, />拒绝</);
  assert.match(html, />取消</);
  assert.match(html, /type="date"/);
  assert.doesNotMatch(html, /type="password"/);
});

test("a password-like schema is not rendered and an idle panel is empty", () => {
  const blocked = {
    ...pending,
    requestedSchema: { type: "object", required: ["secret"], properties: { secret: { type: "string", format: "password" } } },
  } as unknown as ElicitationPending;
  assert.equal(renderToStaticMarkup(<ElicitationForm pending={blocked} values={{}} onChange={() => undefined} onResolve={() => undefined} />), "");
  assert.equal(parsePending({ pending: blocked }), null);
  assert.equal(parsePending({ pending: null }), null);
  assert.equal(parsePending({ pending: { ...pending, requestedSchema: { type: "object", properties: { child: { type: "object" } }, required: [] } } }), null);
  assert.equal(renderToStaticMarkup(<McpElicitation sessionId="0123456789abcdef0123456789abcdef" />), "");
});

test("elicitation tracker ignores malformed and resolved snapshots, scopes errors by pending id, and bounds resolved IDs", () => {
  const tracker = new ElicitationPendingTracker();
  const first = { ...pending, id: "request-a" };
  const second = { ...pending, id: "request-b" };

  assert.deepEqual(parsePendingSnapshot({ pending: null }), { kind: "clear" });
  assert.equal(parsePendingSnapshot({}), null);
  assert.equal(parsePendingSnapshot({ pending: { ...first, requestedSchema: { type: "object" } } }), null);
  assert.deepEqual(tracker.receive({ pending: first }), { accepted: true, pending: first });
  assert.equal(tracker.receive({ pending: { ...first, requestedSchema: { type: "object" } } }).accepted, false);
  assert.equal(tracker.pending?.id, first.id, "an unreadable snapshot must not discard the active draft");

  assert.equal(tracker.completeSubmission(first.id), null);
  assert.equal(tracker.receive({ pending: first }).accepted, false, "a delayed poll must not resurrect the submitted request");
  assert.equal(tracker.receive({ pending: second }).accepted, true, "a new request remains usable after the old one resolves");
  assert.equal(tracker.shouldShowSubmissionError(first.id), false, "an old write failure must not annotate the new form");
  assert.equal(tracker.shouldShowSubmissionError(second.id), true);

  const bounded = new ElicitationPendingTracker();
  for (let index = 0; index < RESOLVED_ELICITATION_LIMIT + 1; index += 1) {
    bounded.completeSubmission(`resolved-${index}`);
  }
  assert.equal(bounded.receive({ pending: { ...pending, id: "resolved-0" } }).accepted, true,
    "the session-local replay fence evicts oldest IDs instead of growing without limit");
});

test("validation rejects bad values and the submit callback receives only a clean answer", () => {
  const schema = pending.requestedSchema;
  assert.equal(validateElicitationContent(schema, { count: 2, agree: true, color: "red" }).ok, false);
  assert.equal(validateElicitationContent(schema, { name: "Ada", count: 2.5, agree: true, color: "red" }).ok, false);
  assert.equal(validateElicitationContent(schema, { name: "Ada", count: 11, agree: true, color: "red" }).ok, false);
  assert.equal(validateElicitationContent(schema, { name: "Ada", count: 2, agree: true, color: "green" }).ok, false);
  assert.equal(validateElicitationContent(schema, { name: "Ada", count: true, agree: true, color: "red" }).ok, false);
  const email = validateElicitationContent(
    { type: "object", required: ["mail"], properties: { mail: { type: "string", format: "email" } } },
    { mail: "not-an-email" },
  );
  assert.equal(email.ok, false);
  if (!email.ok) assert.equal(email.code, "format");

  const seen: ElicitationSubmission[] = [];
  const reject = () => { throw new Error("invalid answer was submitted"); };
  handleElicitationAction("accept", pending, {
    name: "Ada", count: "2", ratio: "0.5", agree: true, color: "red", when: "2026-10-05",
  }, body => seen.push(body), reject);
  assert.deepEqual(seen[0], {
    id: 7,
    action: "accept",
    content: { name: "Ada", count: 2, ratio: 0.5, agree: true, color: "red", when: "2026-10-05" },
  });

  let invalid = "";
  handleElicitationAction("accept", pending, { name: "", count: "2", agree: false, color: "" }, body => seen.push(body), (field, code) => { invalid = `${code}:${field}`; });
  assert.equal(invalid, "required:name");
  assert.equal(seen.length, 1);

  handleElicitationAction("decline", pending, { name: "secret-value" }, body => seen.push(body), reject);
  handleElicitationAction("cancel", pending, { name: "secret-value" }, body => seen.push(body), reject);
  assert.deepEqual(seen[1], { id: 7, action: "decline" });
  assert.deepEqual(seen[2], { id: 7, action: "cancel" });
  assert.equal(JSON.stringify(seen.slice(1)).includes("secret-value"), false);
});

test("string length limits count Unicode code points like Python and allow an emoji through the native input", () => {
  const emojiSchema = {
    type: "object" as const,
    required: ["answer"],
    properties: { answer: { type: "string" as const, maxLength: 1 } },
  };
  assert.deepEqual(validateElicitationContent(emojiSchema, { answer: "😀" }), {
    ok: true,
    content: { answer: "😀" },
  });
  assert.deepEqual(validateElicitationContent(emojiSchema, { answer: "ab" }), {
    ok: false,
    code: "length",
    field: "answer",
  });

  const html = renderToStaticMarkup(
    <ElicitationForm
      pending={{ ...pending, requestedSchema: emojiSchema }}
      values={{}}
      onChange={() => undefined}
      onResolve={() => undefined}
    />,
  );
  // maxlength is in UTF-16 units; 2 units admit one supplementary-plane code point.
  assert.match(html, /id="xn-mcp-elicitation-answer"[^>]*maxLength="2"/);
});

test("shouldDismissElicitationOnEscape: dismisses on ordinary Escape and blocks on IME composition or select elements", () => {
  assert.equal(shouldDismissElicitationOnEscape({ key: "Escape" }), true);
  assert.equal(shouldDismissElicitationOnEscape({ key: "Enter" }), false);

  // IME composition states must block Escape
  assert.equal(shouldDismissElicitationOnEscape({ key: "Escape", isComposing: true }), false);
  assert.equal(shouldDismissElicitationOnEscape({ key: "Escape", nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldDismissElicitationOnEscape({ key: "Escape", keyCode: 229 }), false);
  assert.equal(shouldDismissElicitationOnEscape({ key: "Escape", nativeEvent: { keyCode: 229 } }), false);
  assert.equal(shouldDismissElicitationOnEscape({ key: "Process" }), false);
  assert.equal(shouldDismissElicitationOnEscape({ key: "Dead" }), false);
  assert.equal(shouldDismissElicitationOnEscape({ key: "Escape", compositionActive: true }), false);
});
