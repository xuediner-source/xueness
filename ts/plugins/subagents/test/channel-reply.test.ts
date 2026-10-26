/** F12.05: external channel reply port — channel identity, authorization, attachments (content parts), session association, send receipts. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { contractFor } from "@xueness/agent";
import {
  BACKGROUND_TOOL_NAMES, CHILD_DENIED_TOOLS, coordinationBinding, parseReplyPart, readChannelBinding,
  REPLY_CHANNEL_TOOL_NAME, resolveChannelReplyParts, replyToChannel, replyToChannelTool, SEND_MESSAGE_TOOL_NAME,
  sendMessageTool, type ChannelConfigFile, type ChannelDelivery, type ChannelGroupInputSource, type ChannelReplyDeps,
  type ChannelDeliveryReceipt, type ChannelReplyPart, type ChannelStateFile,
} from "../src/index.ts";

const mention = {
  type: "channelMention" as const, refId: "m1", name: "Ryan Bot", channel: "feishu" as const,
  targetId: "ou_target", idType: "open_id" as const, entityType: "unknown" as const,
};

function fixture() {
  const source: ChannelGroupInputSource = {
    authorizationId: "auth", botId: "bot", appId: "app", provider: "feishu", chatId: "oc_group",
    senderId: "member", senderName: "Member", messageId: "om_input", contentParts: [mention],
  };
  const state: ChannelStateFile = {
    version: 3,
    bots: {
      group: {
        botId: "bot", workspacePath: "/work", activeTaskId: "task",
        group: {
          enabled: true, ownerId: "owner", chatId: "oc_group", authorizationId: "auth",
          inputs: { input: { taskId: "task", admission: "accepted", source } }, deliveries: {},
        },
      },
    },
  };
  const config: ChannelConfigFile = {
    bots: [{ id: "bot", enabled: true, provider: "feishu", providerUserId: "owner", appId: "app" }],
  };
  let deliveries = 0;
  const deliver = async (_bot: unknown, _chat: string, _thread: string | undefined, result: ChannelDelivery) => {
    deliveries++;
    state.bots.group!.group!.deliveries![result.id] ??= { ...result, status: "sent", providerMessageId: "om_sent" };
  };
  const deps: ChannelReplyDeps = { readState: async () => state, readConfig: async () => config, deliver };
  const request = {
    taskId: "task", inputId: "input", toolCallId: "call", authorizationId: "auth", workspacePath: "/work",
    parts: [{ type: "mention" as const, refId: "m1" }, { type: "text" as const, text: " 请确认" }],
  };
  return { state, config, deps, request, deliveries: () => deliveries };
}

const rejects = async (promise: Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && pattern.test(error.message));
};

describe("channel binding identity and authorization (F12.05)", () => {
  it("resolves the single active binding and anchors the requested native input", async () => {
    const { deps, request } = fixture();
    const binding = await readChannelBinding(request, deps);
    assert.equal(binding.key, "group");
    assert.equal(binding.bot.id, "bot");
    assert.equal(binding.sourceCommandId, "input");
    assert.equal(binding.source.messageId, "om_input");
    assert.deepEqual(binding.trusted, [mention]);
  });

  it("requires exactly one active task binding — zero or two are both refused", async () => {
    const { state, deps, request } = fixture();
    state.bots.group!.activeTaskId = undefined;
    await rejects(readChannelBinding(request, deps), /exactly one active task channel binding/);
    state.bots.group!.activeTaskId = "task";
    state.bots.duplicate = structuredClone(state.bots.group!);
    await rejects(readChannelBinding(request, deps), /exactly one active task channel binding/);
  });

  it("refuses a binding from another workspace or workspace identity", async () => {
    const { state, deps, request } = fixture();
    await rejects(readChannelBinding({ ...request, workspacePath: "/elsewhere" }, deps), /exactly one active task channel binding/);
    state.bots.group!.workspaceIdentity = "remote:other";
    await rejects(readChannelBinding(request, deps), /exactly one active task channel binding/);
    state.bots.group!.workspaceIdentity = "remote:here";
    assert.equal((await readChannelBinding({ ...request, workspaceIdentity: "remote:here" }, deps)).key, "group");
  });

  it("refuses changed bot/group authorization", async () => {
    const mutations: Array<(state: ChannelStateFile, config: ChannelConfigFile) => void> = [
      (_state, config) => { config.bots[0]!.enabled = false; },
      (state) => { state.bots.group!.group!.enabled = false; },
      (state) => { state.bots.group!.group!.ownerId = "stranger"; },
      (state) => { state.bots.group!.group!.authorizationId = undefined; },
      (state) => { state.bots.group!.group!.topicActive = false; },
    ];
    for (const mutate of mutations) {
      const { state, config, deps, request } = fixture();
      mutate(state, config);
      await rejects(readChannelBinding(request, deps), /authorization changed/);
    }
    const { deps, request } = fixture();
    await rejects(readChannelBinding({ ...request, authorizationId: "older" }, deps), /authorization changed/);
  });

  it("only native, admitted, non-terminal inputs of this task are eligible anchors", async () => {
    for (const mutate of [
      (input: Record<string, unknown>) => { input.admission = "pending"; },
      (input: Record<string, unknown>) => { input.taskId = "other-task"; },
      (input: Record<string, unknown>) => { (input.source as Record<string, unknown>).appId = "different"; },
      (input: Record<string, unknown>) => { (input.source as Record<string, unknown>).botId = "different"; },
      (input: Record<string, unknown>) => { (input.source as Record<string, unknown>).provider = "lark"; },
      (input: Record<string, unknown>) => { (input.source as Record<string, unknown>).chatId = "different"; },
      (input: Record<string, unknown>) => { (input.source as Record<string, unknown>).threadId = "different"; },
      (input: Record<string, unknown>) => { (input.source as Record<string, unknown>).authorizationId = "old"; },
      (input: Record<string, unknown>) => { input.progress = { status: "cancelled" }; },
      (input: Record<string, unknown>) => { input.progress = { status: "discarded" }; },
      (input: Record<string, unknown>) => { input.progress = { status: "stopped" }; },
    ]) {
      const { state, deps, request } = fixture();
      mutate(state.bots.group!.group!.inputs!.input as unknown as Record<string, unknown>);
      await rejects(readChannelBinding(request, deps), /no longer authorized/);
    }
  });

  it("anchors the requested input when eligible, refuses a stale one, and falls back to the latest", async () => {
    const { state, deps, request } = fixture();
    const group = state.bots.group!.group!;
    group.inputs!.followup = { ...structuredClone(group.inputs!.input!), source: { ...group.inputs!.input!.source, messageId: "om_followup", contentParts: [] } };
    assert.equal((await readChannelBinding({ ...request, inputId: "followup" }, deps)).sourceCommandId, "followup");
    group.inputs!.input!.progress = { status: "stopped" };
    await rejects(readChannelBinding(request, deps), /no longer authorized/);
    // A stale requested input never blocks an unknown-id (desktop) follow-up:
    // that send anchors the latest eligible native input.
    assert.equal((await readChannelBinding({ ...request, inputId: "desktop-input" }, deps)).sourceCommandId, "followup");
    delete group.inputs!.input!.progress;
    assert.equal((await readChannelBinding(request, deps)).sourceCommandId, "input");
  });
});

describe("outbound authorization, session association and send receipts (F12.05)", () => {
  it("delivers through the trusted ref and returns the saved provider receipt", async () => {
    const { deps, request, deliveries } = fixture();
    const result = await replyToChannel(request, deps);
    assert.equal(result.status, "sent");
    assert.equal(result.providerMessageId, "om_sent");
    assert.match(result.deliveryId, /^[a-f0-9]{64}$/);
    assert.equal(deliveries(), 1);
  });

  it("associates the delivery with the run's task, input and tool call", async () => {
    const { state, deps, request } = fixture();
    const result = await replyToChannel(request, deps);
    assert.equal(result.status, "sent");
    const saved = state.bots.group!.group!.deliveries![result.deliveryId]!;
    assert.equal(saved.taskId, "task");
    assert.equal(saved.sourceCommandId, "input");
    assert.equal(saved.replyToMessageId, "om_input");
    assert.equal(saved.authorizationId, "auth");
    assert.match(saved.channelReplyRequestHash!, /^[a-f0-9]{64}$/);
    assert.deepEqual(saved.contentParts, [mention, { type: "text", text: " 请确认" }]);
  });

  it("replays the stored receipt without a second send; a changed request conflicts", async () => {
    const { deps, request, deliveries } = fixture();
    const first = await replyToChannel(request, deps);
    assert.deepEqual(await replyToChannel(request, deps), first);
    assert.equal(deliveries(), 1);
    await rejects(replyToChannel({ ...request, parts: [{ type: "text", text: "different" }] }, deps), /idempotency conflict/);
  });

  it("a recovered unknown or failed delivery re-delivers through the owner and reports honestly", async () => {
    const { state, deps, request, deliveries } = fixture();
    const first = await replyToChannel(request, deps);
    assert.equal(first.status, "sent");
    const record = state.bots.group!.group!.deliveries![first.deliveryId]!;
    record.status = "unknown";
    record.providerMessageId = undefined;
    const replayed = await replyToChannel(request, deps);
    assert.equal(deliveries(), 2);
    // The owner keeps the persistent unknown; the tool result never claims success.
    assert.equal(replayed.status, "unknown");
    assert.equal("providerMessageId" in replayed, false);
    record.status = "failed";
    record.lastError = "rate limited";
    const failed = await replyToChannel(request, deps);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "rate limited");
  });

  it("an existing delivery with different content under the same identity conflicts", async () => {
    const { state, deps, request } = fixture();
    const first = await replyToChannel(request, deps);
    assert.ok(!("status" in first) || first.status !== "needs_clarification");
    const deliveryId = (first as ChannelDeliveryReceipt).deliveryId;
    state.bots.group!.group!.deliveries![deliveryId]!.contentParts = [{ type: "text", text: "swapped" }];
    await rejects(replyToChannel(request, deps), /idempotency conflict/);
  });

  it("a delivery identity differs per tool call, so two calls both send", async () => {
    const { deps, request, deliveries } = fixture();
    assert.equal((await replyToChannel(request, deps)).status, "sent");
    assert.equal((await replyToChannel({ ...request, toolCallId: "call-2" }, deps)).status, "sent");
    assert.equal(deliveries(), 2);
  });

  it("thread ids follow the binding", async () => {
    const { state, deps, request } = fixture();
    state.bots.group!.group!.threadId = "thread-1";
    state.bots.group!.group!.inputs!.input!.source.threadId = "thread-1";
    const seen: Array<string | undefined> = [];
    const threaded: ChannelReplyDeps = { ...deps, deliver: async (bot, chat, thread, result) => { seen.push(thread); await deps.deliver(bot, chat, thread, result); } };
    const { authorizationId: _authorizationId, ...followup } = request;
    assert.equal((await replyToChannel({ ...followup, inputId: "desktop-input" }, threaded)).status, "sent");
    assert.deepEqual(seen, ["thread-1"]);
  });
});

describe("channel attachments: parts and mention resolution (F12.05)", () => {
  const trusted = [mention];

  it("parses reply parts and bounds their fields", () => {
    assert.deepEqual(parseReplyPart({ type: "text", text: "hello" }), { type: "text", text: "hello" });
    assert.equal(parseReplyPart({ type: "text", text: "x".repeat(2001) }), null);
    assert.deepEqual(parseReplyPart({ type: "mention", refId: "m1" }), { type: "mention", refId: "m1" });
    assert.equal(parseReplyPart({ type: "mention", refId: "" }), null);
    assert.deepEqual(parseReplyPart({ type: "mentionName", name: " Ada " }), { type: "mentionName", name: " Ada " });
    assert.deepEqual(parseReplyPart({ type: "mentionName", name: "Ada", candidateRef: "name:abc" }), { type: "mentionName", name: "Ada", candidateRef: "name:abc" });
    assert.equal(parseReplyPart({ type: "mentionName", name: "   " }), null);
    assert.equal(parseReplyPart({ type: "bogus" }), null);
  });

  it("typed refs resolve only against trusted native nodes", () => {
    assert.deepEqual(resolveChannelReplyParts([{ type: "mention", refId: "m1" }], trusted), [mention]);
    assert.throws(() => resolveChannelReplyParts([{ type: "mention", refId: "invented" }], trusted), /Unknown channel mention reference/);
    assert.throws(() => resolveChannelReplyParts([{ type: "mentionName", name: "Ryan Bot" }], trusted), /resolved by Host/);
    assert.throws(() => resolveChannelReplyParts([{ type: "text", text: "   " }], trusted), /1–2000 characters/);
    assert.throws(() => resolveChannelReplyParts([{ type: "text", text: "x".repeat(2001) }], trusted), /1–2000 characters/);
    const conflicting = [{ ...mention, name: "Other Bot" }];
    assert.throws(() => resolveChannelReplyParts([{ type: "mention", refId: "m1" }], [...trusted, ...conflicting]), /Conflicting channel mention reference/);
  });

  it("resolves a unique typed name and replays the receipt without a new lookup", async () => {
    const { deps, request } = fixture();
    let lookups = 0;
    const memberDeps: ChannelReplyDeps = { ...deps, listMembers: async () => { lookups++; return { ou_alice: "Alice" }; } };
    const parts: ChannelReplyPart[] = [{ type: "mentionName", name: " Alice " }];
    const first = await replyToChannel({ ...request, parts }, memberDeps);
    assert.equal(first.status, "sent");
    lookups = 0;
    assert.deepEqual(await replyToChannel({ ...request, parts }, memberDeps), first);
    assert.equal(lookups, 0);
  });

  it("returns ambiguous candidates without delivery and accepts only a valid selected candidate", async () => {
    const { state, deps, request, deliveries } = fixture();
    const memberDeps: ChannelReplyDeps = { ...deps, listMembers: async () => ({ ou_a: "Alex", ou_b: "Alex" }) };
    const parts: ChannelReplyPart[] = [{ type: "mentionName", name: "Alex" }];
    const result = await replyToChannel({ ...request, parts }, memberDeps);
    assert.equal(result.status, "needs_clarification");
    assert.equal(deliveries(), 0);
    const unresolved = result.status === "needs_clarification" ? result.unresolved[0]! : null;
    assert.equal(unresolved!.reason, "ambiguous");
    assert.equal(unresolved!.candidates.length, 2);
    const candidateRef = unresolved!.candidates[1]!.ref;
    assert.ok(!candidateRef.includes("ou_b"));
    // The user picks a candidate in a follow-up input: identity survives, authorization does not widen.
    const group = state.bots.group!.group!;
    group.inputs!.followup = { ...structuredClone(group.inputs!.input!), source: { ...group.inputs!.input!.source, messageId: "om_choice", contentParts: [] } };
    const selected = await replyToChannel({ ...request, inputId: "followup", toolCallId: "selected", parts: [{ type: "mentionName", name: "Alex", candidateRef }] }, memberDeps);
    assert.equal(selected.status, "sent");
    const saved = Object.values(group.deliveries!)[0]!;
    const savedPart = saved.contentParts![0]!;
    assert.equal(savedPart.type === "channelMention" ? savedPart.targetId : "", "ou_b");
    const invented = await replyToChannel({ ...request, parts: [{ type: "mentionName", name: "Alex", candidateRef: "invented" }] }, memberDeps);
    assert.equal(invented.status, "needs_clarification");
    assert.equal(deliveries(), 1);
  });

  it("resolves a known bot name from trusted task mentions", async () => {
    const { state, deps, request } = fixture();
    const memberDeps: ChannelReplyDeps = { ...deps, listMembers: async () => ({}) };
    assert.equal((await replyToChannel({ ...request, parts: [{ type: "mentionName", name: "Ryan Bot" }] }, memberDeps)).status, "sent");
    const saved = Object.values(state.bots.group!.group!.deliveries!)[0]!;
    const part = saved.contentParts![0]!;
    assert.equal(part.type === "channelMention" ? part.targetId : "", "ou_target");
  });

  it("resolves names from an earlier task without authorizing its mention refs", async () => {
    const { state, deps, request } = fixture();
    const group = state.bots.group!.group!;
    group.inputs!.old = { ...structuredClone(group.inputs!.input!), taskId: "previous-task", progress: { status: "stopped" } };
    group.inputs!.input!.source.contentParts = [{ type: "text", text: "Find ryan" }];
    const memberDeps: ChannelReplyDeps = { ...deps, listMembers: async () => ({}) };
    assert.equal((await replyToChannel({ ...request, parts: [{ type: "mentionName", name: "ryan" }] }, memberDeps)).status, "sent");
    const saved = Object.values(group.deliveries!)[0]!;
    const part = saved.contentParts![0]!;
    assert.equal(part.type === "channelMention" ? part.name : "", "Ryan Bot");
    // The earlier task's native node stays a name candidate only — its ref is not trusted.
    await rejects(replyToChannel({ ...request, toolCallId: "old-ref" }, deps), /Unknown channel mention/);
  });

  for (const field of ["authorizationId", "chatId", "appId", "botId", "provider"] as const) {
    it(`excludes historical names from a different ${field}`, async () => {
      const { state, deps, request, deliveries } = fixture();
      const group = state.bots.group!.group!;
      group.inputs!.old = { ...structuredClone(group.inputs!.input!), taskId: "previous-task" };
      (group.inputs!.old.source as unknown as Record<string, unknown>)[field] = "different";
      group.inputs!.input!.source.contentParts = [{ type: "text", text: "Find ryan" }];
      const result = await replyToChannel({ ...request, parts: [{ type: "mentionName", name: "ryan" }] }, { ...deps, listMembers: async () => ({}) });
      assert.equal(result.status, "needs_clarification");
      assert.deepEqual(result.status === "needs_clarification" ? result.unresolved : [], [{ name: "ryan", reason: "not_found", candidates: [], truncated: false }]);
      assert.equal(deliveries(), 0);
    });
  }

  it("treats a directory user and a trusted bot with the same name as ambiguous", async () => {
    const { deps, request, deliveries } = fixture();
    const result = await replyToChannel({ ...request, parts: [{ type: "mentionName", name: "ryan bot" }] }, { ...deps, listMembers: async () => ({ ou_person: "Ryan Bot" }) });
    assert.equal(result.status, "needs_clarification");
    assert.equal(result.status === "needs_clarification" ? result.unresolved[0]!.candidates.length : 0, 2);
    assert.equal(deliveries(), 0);
  });

  it("does not partially deliver mixed resolved and missing recipients", async () => {
    const { deps, request, deliveries } = fixture();
    const parts: ChannelReplyPart[] = [{ type: "mention", refId: "m1" }, { type: "mentionName", name: "Unknown" }];
    const result = await replyToChannel({ ...request, parts }, { ...deps, listMembers: async () => ({}) });
    assert.equal(result.status, "needs_clarification");
    assert.equal(deliveries(), 0);
  });

  it("bounds duplicate-name candidates and rejects a candidate from another credential scope", async () => {
    const { config, deps, request, deliveries } = fixture();
    const roster = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ["ou_member_" + i, "Alex"]));
    const memberDeps: ChannelReplyDeps = { ...deps, listMembers: async () => roster };
    const parts: ChannelReplyPart[] = [{ type: "mentionName", name: "Alex" }];
    const result = await replyToChannel({ ...request, parts }, memberDeps);
    assert.equal(result.status, "needs_clarification");
    const unresolved = result.status === "needs_clarification" ? result.unresolved[0]! : null;
    assert.equal(unresolved!.candidates.length, 10);
    assert.equal(unresolved!.truncated, true);
    config.bots[0]!.credentialRef = "new-credential";
    const selected = await replyToChannel({ ...request, parts: [{ type: "mentionName", name: "Alex", candidateRef: unresolved!.candidates[0]!.ref }] }, memberDeps);
    assert.equal(selected.status, "needs_clarification");
    assert.equal(selected.status === "needs_clarification" ? selected.unresolved[0]!.reason : "", "selection_expired");
    assert.equal(deliveries(), 0);
  });

  it("rejects binding changes during lookup even when the directory returns a unique match", async () => {
    const { config, deps, request, deliveries } = fixture();
    await rejects(replyToChannel({ ...request, parts: [{ type: "mentionName", name: "Alice" }] }, {
      ...deps,
      listMembers: async () => { config.bots[0]!.credentialRef = "changed"; return { ou_alice: "Alice" }; },
    }), /authorization changed during lookup/);
    assert.equal(deliveries(), 0);
  });

  for (const kind of ["missing", "denied", "revoked"] as const) {
    it(`never sends for ${kind} name lookup`, async () => {
      const { state, deps, request, deliveries } = fixture();
      const parts: ChannelReplyPart[] = [{ type: "mentionName", name: "Alice" }];
      const memberDeps: ChannelReplyDeps = {
        ...deps,
        listMembers: async (): Promise<Record<string, string>> => {
          if (kind === "denied") throw new Error("permission denied");
          if (kind === "revoked") state.bots.group!.group!.enabled = false;
          return kind === "missing" ? {} : { ou_alice: "Alice" };
        },
      };
      if (kind === "revoked") await rejects(replyToChannel({ ...request, parts }, memberDeps), /authorization changed/);
      else {
        const result = await replyToChannel({ ...request, parts }, memberDeps);
        assert.equal(result.status, "needs_clarification");
        assert.equal(result.status === "needs_clarification" ? result.unresolved[0]!.reason : "", kind === "missing" ? "not_found" : "unavailable");
      }
      assert.equal(deliveries(), 0);
    });
  }

  it("does not borrow targets from a different task even with a valid binding", async () => {
    const { state, deps, request, deliveries } = fixture();
    const group = state.bots.group!.group!;
    group.inputs!.old = { ...structuredClone(group.inputs!.input!), taskId: "other-task" };
    group.inputs!.input!.source.contentParts = [];
    await rejects(replyToChannel(request, deps), /Unknown channel mention/);
    assert.equal(deliveries(), 0);
  });
});

describe("reply_to_channel tool: port binding and non-conflation (F12.05)", () => {
  it("refuses everywhere the host bound no channel reply port", async () => {
    const tool = replyToChannelTool();
    const refused = await tool.run({ parts: [{ type: "text", text: "hi" }] }, {} as never);
    assert.equal(refused.ok, false);
    assert.equal((refused.error as Record<string, unknown>).code, "channel_reply_unavailable");
  });

  it("forwards the parts to the host port and returns the channel receipt", async () => {
    const tool = replyToChannelTool();
    const seen: unknown[] = [];
    const port = { reply: async (parts: unknown) => { seen.push(parts); return { status: "sent", deliveryId: "d1", providerMessageId: "om1" }; } };
    const result = await tool.run({ parts: [{ type: "text", text: " 请确认" }, { type: "mention", refId: "m1" }] }, { channelReplyPort: port } as never);
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [[{ type: "text", text: " 请确认" }, { type: "mention", refId: "m1" }]]);
    assert.equal((result.data as Record<string, unknown>).deliveryId, "d1");
    assert.match(result.output, /"status":"sent"/);
  });

  it("a refused port outcome surfaces its reason, not a generic failure", async () => {
    const tool = replyToChannelTool();
    const port = { reply: async () => ({ ok: false, error: "Channel reply authorization changed" }) };
    const refused = await tool.run({ parts: [{ type: "text", text: "hi" }] }, { channelReplyPort: port } as never);
    assert.equal(refused.ok, false);
    assert.equal((refused.error as Record<string, unknown>).code, "channel_reply_refused");
    assert.equal((refused.error as Record<string, unknown>).message, "Channel reply authorization changed");
  });

  it("needs_clarification is a successful tool call, not a delivery claim", async () => {
    const tool = replyToChannelTool();
    const port = { reply: async () => ({ status: "needs_clarification", unresolved: [{ name: "Alex", reason: "ambiguous", candidates: [], truncated: false }] }) };
    const result = await tool.run({ parts: [{ type: "mentionName", name: "Alex" }] }, { channelReplyPort: port } as never);
    assert.equal(result.ok, true);
    assert.equal((result.data as Record<string, unknown>).status, "needs_clarification");
  });

  it("empty parts are an argument error", async () => {
    const tool = replyToChannelTool();
    const port = { reply: async () => ({ status: "sent", deliveryId: "d" }) };
    const refused = await tool.run({ parts: [] }, { channelReplyPort: port } as never);
    assert.equal(refused.ok, false);
    assert.equal((refused.error as Record<string, unknown>).code, "invalid_argument");
  });

  it("is a channel delivery port, never the subagent SendMessage surface", () => {
    // Distinct tool, distinct name, distinct receipts: channel replies never ride the coordinator's message inbox.
    assert.notEqual(REPLY_CHANNEL_TOOL_NAME, SEND_MESSAGE_TOOL_NAME);
    assert.notEqual(replyToChannelTool().name, sendMessageTool(coordinationBinding()).name);
    assert.equal(BACKGROUND_TOOL_NAMES.includes(REPLY_CHANNEL_TOOL_NAME), false);
    assert.equal(CHILD_DENIED_TOOLS.includes(REPLY_CHANNEL_TOOL_NAME), true);
    assert.equal(contractFor("reply_to_channel")!.model, "ReplyToChannel");
    assert.match(contractFor("reply_to_channel")!.description, /needs_clarification/);
  });

  it("model contract round-trips parts without inventing platform ids", () => {
    const contract = contractFor("reply_to_channel")!;
    const input = { parts: [{ type: "text", text: "hi" }, { type: "mentionName", name: "Alex", candidateRef: "name:abc" }] };
    const internal = contract.toInternal(input, { root: "/w", accepts: () => true });
    assert.deepEqual(internal, { parts: [{ type: "text", text: "hi" }, { type: "mentionName", name: "Alex", candidateRef: "name:abc" }] });
    assert.deepEqual(contract.toModel(internal as Record<string, unknown>, { root: "/w", accepts: () => true }), input);
    assert.ok("error" in contract.toInternal({ parts: [{ type: "bogus" }] }, { root: "/w", accepts: () => true }));
  });
});
