/**
 * ZCode v3.15.1 (aac4755, Apache-2.0) ReplyToChannel tool contract:
 * description and provider schema from
 * `core/src/tool/handlers/reply-to-channel.ts`. The Xueness tool is
 * `reply_to_channel` (the subagents plugin's channel reply port, F12.05); the
 * provider schema does not expose anyOf — the per-type field combinations are
 * enforced by the runtime schema and the Host-side part validation.
 */
import type { JsonSchema } from "@xueness/contracts";
import type { InputAdapter } from "./adapters.ts";

type Row = Record<string, unknown>;

export const CHANNEL_REPLY_DESCRIPTION = "Send an additional reply to the current Feishu/Lark conversation ONLY when the user explicitly asks you to send or mention someone. No additional tool approval is needed for this authorized conversation. Prefer trusted mention refIds; when the user supplies only a name, use mentionName and let Host resolve the current group directory and trusted task mentions. Preserve spaces inside a full name (Alex Smith is one recipient); split multiple recipients only on explicit list delimiters such as 、, commas, or newlines, never whitespace alone. Host uses name containment and automatically selects a unique candidate or a unique exact name among multiple matches. Never guess platform IDs. needs_clarification lists ALL unresolved names after checking every requested name and means NOTHING was sent. Only report the returned facts; never claim delivery or invent a match. Keep all original recipients when retrying after clarification: show candidate labels and ask the user to choose; never select an ambiguous candidate yourself. After an explicit choice use a new call with name and the returned candidateRef. For not_found/unavailable/selection_expired or truncated candidates, explain the issue and ask for a native @ mention. Group member APIs do not enumerate bots; unknown bots need a native mention first. Normal final answers are delivered automatically. After sent, do not duplicate that request. A sent message does not mean another bot responded.";

export const CHANNEL_REPLY_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "required": ["parts"],
  "properties": {
    "parts": {
      "type": "array",
      "minItems": 1,
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type"],
        "properties": {
          "type": { "type": "string", "enum": ["text", "mention", "mentionName"] },
          "text": { "type": "string", "maxLength": 2000, "description": "Required only for type=text; omit refId." },
          "refId": { "type": "string", "minLength": 1, "maxLength": 200, "description": "Required only for type=mention; use the current trusted reference and omit text." },
          "name": { "type": "string", "minLength": 1, "maxLength": 200, "description": "Required only for mentionName: recipient name or partial name supplied by the user; preserve internal spaces, one explicit list item per part; omit text/refId." },
          "candidateRef": { "type": "string", "minLength": 1, "maxLength": 200, "description": "Only for mentionName after the user explicitly selects a returned candidate; never invent or auto-select." },
        },
      },
    },
  },
} as unknown as JsonSchema;

/** Parts pass through with only the fields their type carries; the tool's runtime schema is the same shape. */
export const channelReplyAdapter: InputAdapter = {
  toInternal(input) {
    if (!Array.isArray(input.parts)) return { error: "parts must be an array of content parts" };
    const parts = input.parts.map((part) => {
      const row = part as Row;
      if (row?.type === "text") return { type: "text", text: row.text };
      if (row?.type === "mention") return { type: "mention", refId: row.refId };
      if (row?.type === "mentionName") return { type: "mentionName", name: row.name, ...(row.candidateRef === undefined ? {} : { candidateRef: row.candidateRef }) };
      return null;
    });
    if (parts.some((part) => part === null)) return { error: "each part must be text, mention or mentionName" };
    return { parts };
  },
  toModel(input) {
    if (!Array.isArray(input.parts)) return {};
    return {
      parts: input.parts.map((part) => {
        const row = part as Row;
        if (row?.type === "text") return { type: "text", text: row.text };
        if (row?.type === "mention") return { type: "mention", refId: row.refId };
        if (row?.type === "mentionName") return { type: "mentionName", name: row.name, ...(row.candidateRef === undefined ? {} : { candidateRef: row.candidateRef }) };
        return row;
      }),
    };
  },
};
