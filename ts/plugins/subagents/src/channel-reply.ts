/**
 * External channel reply port (F12.05, from ZCode v3.15.1
 * `packages/services/src/bots/channelReply.ts` and the `ReplyToChannel`
 * handler in `apps/zcode-cli/packages/core/src/tool/handlers/`).
 *
 * The send binding belongs to the task and is resolved by the Host alone: a
 * reply runs only when exactly one active channel binding matches the task,
 * workspace and workspace identity, its bot/group authorization is unchanged,
 * and the anchoring input is a native, admitted, non-terminal input of that
 * same task. Every outbound delivery is idempotent per
 * (bot, task, input, tool call): a replay returns the stored receipt, a
 * different request under the same identity is a conflict, and a recovered
 * `unknown` receipt is reported as unknown — never silently resent.
 */
import { createHash } from "node:crypto";
import { isDict } from "@xueness/contracts";
import { parseChannelMention, resolveChannelMentionNames, type ChannelClarification, type ChannelContentPart, type ChannelProvider } from "./channel-mention.ts";

export interface ChannelReplyTextPart { type: "text"; text: string }
export interface ChannelReplyMentionPart { type: "mention"; refId: string }
export interface ChannelReplyMentionNamePart { type: "mentionName"; name: string; candidateRef?: string }
export type ChannelReplyPart = ChannelReplyTextPart | ChannelReplyMentionPart | ChannelReplyMentionNamePart;

/** A send receipt: what the provider actually reported, not what was hoped for. */
export interface ChannelDeliveryReceipt {
  status: "sent" | "failed" | "unknown" | "invalidated";
  deliveryId: string;
  providerMessageId?: string;
  error?: string;
}
export type ChannelReplyResult = ChannelDeliveryReceipt | ChannelClarification;

export interface ChannelDelivery {
  id: string;
  /** Fingerprint of the pre-resolution request; replays never re-resolve names. */
  channelReplyRequestHash?: string;
  appId?: string;
  authorizationId?: string;
  taskId: string;
  sourceCommandId?: string;
  text: string;
  replyToMessageId?: string;
  contentParts?: ChannelContentPart[];
  providerMessageId?: string;
  threadId?: string;
  rootMessageId?: string;
  status: "pending" | "sent" | "failed" | "unknown" | "invalidated";
  lastError?: string;
  updatedAt: number;
}

export interface ChannelGroupInputSource {
  appId?: string;
  contentParts?: ChannelContentPart[];
  authorizationId?: string;
  botId: string;
  provider: ChannelProvider;
  chatId: string;
  threadId?: string;
  rootMessageId?: string;
  senderId: string;
  senderName: string;
  messageId: string;
}
export interface ChannelGroupInput {
  taskId: string;
  source: ChannelGroupInputSource;
  admission?: "pending" | "accepted" | "rejected";
  progress?: { status?: string };
}
export interface ChannelGroupContext {
  chatId: string;
  threadId?: string;
  enabled: boolean;
  ownerId: string;
  authorizationId?: string;
  /** A topic the group left keeps its task but stops normal traffic. */
  topicActive?: boolean;
  inputs?: Record<string, ChannelGroupInput>;
  deliveries?: Record<string, ChannelDelivery>;
}
export interface ChannelBotState {
  botId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  activeTaskId?: string;
  group?: ChannelGroupContext;
}
export interface ChannelStateFile { version: 3; bots: Record<string, ChannelBotState> }
export interface ChannelBotConfig { id: string; enabled: boolean; provider: ChannelProvider; providerUserId: string; appId?: string; credentialRef?: string }
export interface ChannelConfigFile { bots: ChannelBotConfig[] }

export interface ChannelReplyRequest {
  taskId: string;
  inputId: string;
  toolCallId: string;
  parts: ChannelReplyPart[];
  authorizationId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ChannelReplyDeps {
  readState(): Promise<ChannelStateFile>;
  readConfig(): Promise<ChannelConfigFile>;
  listMembers?(bot: ChannelBotConfig, chatId: string): Promise<Record<string, string>>;
  deliver(bot: ChannelBotConfig, chatId: string, threadId: string | undefined, result: ChannelDelivery): Promise<void>;
}

export function channelContentText(parts: readonly ChannelContentPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : `@${part.name}`)).join("");
}

export function parseReplyPart(value: unknown): ChannelReplyPart | null {
  if (!isDict(value)) return null;
  if (value.type === "text") return typeof value.text === "string" && value.text.length <= 2000 ? { type: "text", text: value.text } : null;
  if (value.type === "mention") return typeof value.refId === "string" && value.refId.length >= 1 && value.refId.length <= 200 ? { type: "mention", refId: value.refId } : null;
  if (value.type === "mentionName") {
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 200) return null;
    const part: ChannelReplyMentionNamePart = { type: "mentionName", name: value.name };
    if (typeof value.candidateRef === "string" && value.candidateRef.length >= 1 && value.candidateRef.length <= 200) part.candidateRef = value.candidateRef;
    return part;
  }
  return null;
}

/**
 * Resolve typed `mention` refs against the trusted native nodes only. The
 * model cannot supply platform IDs: a ref the Host never admitted is unknown,
 * a name that still needs resolution is refused here (that is the Host's job),
 * and two trusted nodes sharing one ref with different identities conflict.
 */
export function resolveChannelReplyParts(parts: readonly ChannelReplyPart[], source: readonly ChannelContentPart[]): ChannelContentPart[] {
  const targets = new Map<string, NonNullable<ReturnType<typeof parseChannelMention>>>();
  for (const part of source) {
    if (part.type !== "channelMention") continue;
    const target = parseChannelMention(part);
    if (!target) throw new Error("Invalid channel mention reference");
    const previous = targets.get(target.refId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(target)) throw new Error("Conflicting channel mention reference");
    targets.set(target.refId, target);
  }
  const resolved = parts.map((part) => {
    if (part.type === "text") return part;
    if (part.type === "mentionName") throw new Error("Channel mention name must be resolved by Host");
    const target = targets.get(part.refId);
    if (!target) throw new Error("Unknown channel mention reference");
    return target;
  });
  if (!channelContentText(resolved).trim() || channelContentText(resolved).length > 2000)
    throw new Error("Channel reply must contain 1–2000 characters");
  return resolved;
}

export interface ChannelBinding {
  key: string;
  group: ChannelGroupContext;
  bot: ChannelBotConfig;
  source: ChannelGroupInputSource;
  sourceCommandId: string;
  trusted: ChannelContentPart[];
  nameCandidates: ChannelContentPart[];
  scope: string;
}

/** One active task binding per (task, workspace, identity) — never a fallback to another task or an older authorization. */
export async function readChannelBinding(request: ChannelReplyRequest, deps: ChannelReplyDeps): Promise<ChannelBinding> {
  const [state, config] = await Promise.all([deps.readState(), deps.readConfig()]);
  const matches = Object.entries(state.bots).filter(([, context]) =>
    context.activeTaskId === request.taskId &&
    context.workspacePath === request.workspacePath &&
    (context.workspaceIdentity?.trim() || context.workspacePath) === (request.workspaceIdentity?.trim() || request.workspacePath) &&
    Boolean(context.group));
  if (matches.length !== 1)
    throw new Error("Channel reply requires exactly one active task channel binding; do not retry without restoring the binding");
  const [key, context] = matches[0]!;
  const group = context.group!;
  const bot = config.bots.find((candidate) => candidate.id === context.botId);
  if (!bot?.enabled || !group.enabled || group.ownerId !== bot.providerUserId || !group.authorizationId ||
    (request.authorizationId !== undefined && group.authorizationId !== request.authorizationId) || group.topicActive === false)
    throw new Error("Channel reply authorization changed");
  // The input's origin is not send authorization: native identity (app, bot,
  // provider, chat, thread, authorization) must match the binding exactly.
  const nativeInputs = Object.entries(group.inputs ?? {}).filter(([, input]) => {
    const source = input.source;
    return input.admission === "accepted" &&
      source.appId === bot.appId && Boolean(source.appId) &&
      source.botId === bot.id && source.provider === bot.provider &&
      source.chatId === group.chatId && source.threadId === group.threadId &&
      source.authorizationId === group.authorizationId;
  });
  const eligible = nativeInputs.filter(([, input]) =>
    input.taskId === request.taskId && !["cancelled", "discarded", "stopped"].includes(input.progress?.status ?? ""));
  // Native identity survives task switches; history nodes are name candidates
  // only and never widen what a current send may reference.
  const nameCandidates = nativeInputs.flatMap(([, { source }]) => source.contentParts ?? []);
  const current = group.inputs?.[request.inputId];
  if (current && !eligible.some(([id]) => id === request.inputId))
    throw new Error("Channel reply execution input is no longer authorized");
  const anchor = eligible.find(([id]) => id === request.inputId) ?? eligible.at(-1);
  if (!anchor)
    throw new Error("Channel reply has no valid native conversation context; do not retry unchanged");
  const [sourceCommandId, { source }] = anchor;
  const trusted = eligible.flatMap(([, { source }]) => source.contentParts ?? []);
  const scope = JSON.stringify([
    key, request.taskId, context.workspaceIdentity?.trim() || context.workspacePath,
    bot.id, bot.provider, bot.appId, bot.credentialRef, bot.providerUserId, group.authorizationId,
  ]);
  return { key, group, bot, source, sourceCommandId, trusted, nameCandidates, scope };
}

/**
 * A stored delivery must still describe this request. The request hash catches a
 * changed request; this catches the other half — a record whose content no
 * longer matches the request it claims to answer, which must never be reported
 * as a delivery of the requested text.
 */
function sameReplyShape(request: readonly ChannelReplyPart[], stored: readonly ChannelContentPart[] | undefined, text: string): boolean {
  if (!stored) return true;
  // A record whose parts and rendered text disagree was altered outside the
  // send path; replaying it would attribute unrelated content to this request.
  if (typeof text === "string" && channelContentText(stored) !== text) return false;
  const texts = (parts: readonly ChannelContentPart[] | readonly ChannelReplyPart[]) =>
    parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []));
  const mentions = (parts: readonly ChannelContentPart[] | readonly ChannelReplyPart[]) => parts.filter((part) => part.type !== "text").length;
  const [requestTexts, storedTexts] = [texts(request), texts(stored)];
  return mentions(request) === mentions(stored) && requestTexts.length === storedTexts.length &&
    requestTexts.every((text, index) => text === storedTexts[index]);
}

function receipt(saved: ChannelDelivery | undefined, id: string): ChannelDeliveryReceipt {
  return {
    status: saved?.status === "sent" || saved?.status === "failed" || saved?.status === "invalidated" ? saved.status : "unknown",
    deliveryId: id,
    ...(saved?.providerMessageId ? { providerMessageId: saved.providerMessageId } : {}),
    ...(saved?.lastError ? { error: saved.lastError } : {}),
  };
}

/**
 * Send one reply through the task's authorized channel binding. Idempotent per
 * (bot, task, input, tool call); a name lookup re-reads the binding so a
 * rebinding during the lookup can never carry the old authorization forward.
 */
export async function replyToChannel(request: ChannelReplyRequest, deps: ChannelReplyDeps): Promise<ChannelReplyResult> {
  let binding = await readChannelBinding(request, deps);
  const { bot } = binding;
  const id = createHash("sha256")
    .update(JSON.stringify(["channel-reply", bot.id, request.taskId, request.inputId, request.toolCallId]))
    .digest("hex");
  const requestHash = createHash("sha256")
    .update(JSON.stringify(request.parts.map((part) =>
      part.type === "text" ? [part.type, part.text]
        : part.type === "mention" ? [part.type, part.refId]
          : [part.type, part.name, part.candidateRef ?? null])))
    .digest("hex");
  const replay = async (saved: ChannelDelivery | undefined): Promise<ChannelReplyResult | undefined> => {
    if (!saved?.channelReplyRequestHash) return undefined;
    if (saved.channelReplyRequestHash !== requestHash) throw new Error("Channel reply idempotency conflict");
    if (!sameReplyShape(request.parts, saved.contentParts, saved.text)) throw new Error("Channel reply idempotency conflict");
    // `unknown` marks crash recovery, not a finished send: reuse the delivery
    // owner's wait; a persistent record without an active send stays unsent.
    if (saved.status !== "sent" && saved.status !== "invalidated") {
      await deps.deliver(bot, binding.group.chatId, binding.group.threadId, saved);
      saved = (await deps.readState()).bots[binding.key]?.group?.deliveries?.[id];
    }
    return receipt(saved, id);
  };
  const previous = await replay(binding.group.deliveries?.[id]);
  if (previous) return previous;
  let parts: ChannelContentPart[];
  if (request.parts.some((part) => part.type === "mentionName")) {
    let members: Record<string, string> | undefined;
    try { members = await deps.listMembers?.(bot, binding.group.chatId); }
    catch { /* a failed directory becomes an explainable clarification, never a partial roster */ }
    // The binding may have been rebound, stopped or disabled during the lookup;
    // directory results must never extend the old authorization.
    const fresh = await readChannelBinding(request, deps);
    if (fresh.scope !== binding.scope || fresh.sourceCommandId !== binding.sourceCommandId || fresh.source.messageId !== binding.source.messageId)
      throw new Error("Channel reply authorization changed during lookup");
    binding = fresh;
    const concurrent = await replay(binding.group.deliveries?.[id]);
    if (concurrent) return concurrent;
    const resolved = resolveChannelMentionNames(request.parts, binding.trusted, members, binding.scope, bot.provider, binding.nameCandidates);
    if ("status" in resolved) return resolved;
    parts = resolved.parts;
  } else parts = resolveChannelReplyParts(request.parts, binding.trusted);
  if (parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider))
    throw new Error("Channel mention provider mismatch");
  if (!channelContentText(parts).trim() || channelContentText(parts).length > 2000)
    throw new Error("Channel reply must contain 1–2000 characters");
  const { group, source, sourceCommandId, key } = binding;
  const existing = group.deliveries?.[id];
  if (existing && JSON.stringify(existing.contentParts) !== JSON.stringify(parts))
    throw new Error("Channel reply idempotency conflict");
  await deps.deliver(bot, group.chatId, group.threadId, {
    id, channelReplyRequestHash: requestHash, appId: source.appId, authorizationId: group.authorizationId,
    taskId: request.taskId, sourceCommandId, text: channelContentText(parts), contentParts: parts,
    replyToMessageId: source.messageId, threadId: source.threadId, rootMessageId: source.rootMessageId,
    status: "pending", updatedAt: Date.now(),
  });
  const saved = (await deps.readState()).bots[key]?.group?.deliveries?.[id];
  if (saved && JSON.stringify(saved.contentParts) !== JSON.stringify(parts))
    throw new Error("Channel reply idempotency conflict");
  return receipt(saved, id);
}
