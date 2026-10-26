/**
 * Channel mention resolution (F12.05, from ZCode v3.15.1
 * `packages/shared/src/channel-mention.ts` and
 * `packages/services/src/bots/channelMentionResolver.ts`).
 *
 * A name the model quotes is only a query: the candidate identity it stands
 * for can come from the provider directory or from native mention nodes the
 * Host already admitted — never from the model's own platform IDs. Unique
 * matches resolve automatically (a unique exact name first, else a unique
 * containment candidate); everything else is collected into one
 * `needs_clarification` verdict that lists EVERY unresolved name, because a
 * partial send would let the model report recipients that were never reached.
 */
import { createHash } from "node:crypto";
import { isDict } from "@xueness/contracts";

export type ChannelProvider = "feishu" | "lark";

export interface ChannelMention {
  type: "channelMention";
  refId: string;
  name: string;
  channel: ChannelProvider;
  targetId: string;
  idType: "open_id";
  entityType: "user" | "bot" | "unknown";
}

export interface ChannelTextPart { type: "text"; text: string }
export type ChannelContentPart = ChannelTextPart | ChannelMention;

export interface MentionCandidate {
  ref: string;
  name: string;
  label: string;
  kind: "user" | "bot" | "unknown";
}

export interface UnresolvedName {
  name: string;
  reason: "ambiguous" | "not_found" | "unavailable" | "selection_expired";
  candidates: MentionCandidate[];
  truncated: boolean;
}

export interface ChannelClarification {
  status: "needs_clarification";
  unresolved: UnresolvedName[];
}

const MAX_CANDIDATES = 10;
const TARGET = /^ou_[a-zA-Z0-9_-]+$/u;
const bounded = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;

const normalizeName = (name: string): string => name.normalize("NFKC").trim().toLowerCase();

/** `channelMention` shape as the Host persists it (ZCode `channelMentionSchema`). */
export function parseChannelMention(value: unknown): ChannelMention | null {
  if (!isDict(value) || value.type !== "channelMention") return null;
  const { refId, name, channel, targetId, idType, entityType } = value;
  if (!bounded(refId, 1, 200) || !bounded(name, 1, 200)) return null;
  if (channel !== "feishu" && channel !== "lark") return null;
  if (typeof targetId !== "string" || targetId.length > 128 || !TARGET.test(targetId)) return null;
  if (idType !== "open_id") return null;
  if (entityType !== "user" && entityType !== "bot" && entityType !== "unknown") return null;
  return { type: "channelMention", refId, name, channel, targetId, idType, entityType };
}

export const mentionNodes = (parts: readonly ChannelContentPart[]): ChannelMention[] =>
  parts.map(parseChannelMention).filter((part): part is ChannelMention => part !== null);

/**
 * Resolve `mentionName` parts against the provider directory and the trusted
 * native mention nodes. Directory members are candidates too, but a failed
 * directory lookup is an explainable `unavailable` for every name asked — an
 * incomplete roster must never masquerade as a unique match.
 */
export function resolveChannelMentionNames(
  parts: ReadonlyArray<{ type: string; name?: unknown; candidateRef?: unknown }>,
  trusted: readonly ChannelContentPart[],
  members: Record<string, string> | undefined,
  scope: string,
  channel: ChannelProvider,
  nameCandidates: readonly ChannelContentPart[] = [],
): { parts: ChannelContentPart[] } | ChannelClarification {
  const nodes: ChannelMention[] = [...mentionNodes([...trusted, ...nameCandidates])];
  if (members) {
    for (const [targetId, name] of Object.entries(members)) {
      const node = parseChannelMention({ type: "channelMention", targetId, name, channel, refId: "directory", idType: "open_id", entityType: "user" });
      if (node) nodes.push(node);
    }
  }
  const resolved: ChannelContentPart[] = [];
  const unresolved: UnresolvedName[] = [];
  for (const part of parts) {
    if (part.type !== "mentionName") continue;
    const name = typeof part.name === "string" ? part.name : "";
    const wanted = normalizeName(name);
    const byId = new Map<string, ChannelMention>();
    for (const node of nodes) {
      // Name containment only: the user's text is a query, never a platform ID.
      if (node.channel === channel && wanted && normalizeName(node.name).includes(wanted)) byId.set(node.targetId, node);
    }
    const candidates = [...byId.values()]
      .sort((a, b) => a.targetId.localeCompare(b.targetId))
      .map((node) => ({ node, ref: `name:${createHash("sha256").update(JSON.stringify([scope, node.targetId])).digest("hex")}` }));
    const exact = candidates.filter(({ node }) => normalizeName(node.name) === wanted);
    const automatic = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    const candidateRef = typeof part.candidateRef === "string" ? part.candidateRef : undefined;
    const selected = candidateRef ? candidates.find((candidate) => candidate.ref === candidateRef) : automatic;
    // A directory user and a trusted bot sharing one name stay ambiguous, and a
    // missing directory never promotes incomplete candidates to a match.
    if (members && selected) {
      resolved.push({ ...selected.node, refId: selected.ref });
      continue;
    }
    // Collect every unresolved name — one failure must not hide the rest.
    unresolved.push({
      name,
      reason: !members ? "unavailable" : candidateRef ? "selection_expired" : candidates.length ? "ambiguous" : "not_found",
      candidates: members
        ? candidates.slice(0, MAX_CANDIDATES).map(({ node, ref }) => ({
          ref, name: node.name, kind: node.entityType, label: `${node.name} (${node.entityType}, …${node.targetId.slice(-6)})`,
        }))
        : [],
      truncated: candidates.length > MAX_CANDIDATES,
    });
  }
  return unresolved.length ? { status: "needs_clarification", unresolved } : { parts: resolved };
}
