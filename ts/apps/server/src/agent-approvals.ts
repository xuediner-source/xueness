/** Replay exactly one journaled denied call under its original approval identity. */
import { isDict, pyJsonDumps, pyJsonLoads, pySlice } from "@xueness/contracts";
import { evidenceAliases, saveToolMedia, type AgentExtension, type Row } from "@xueness/agent";
import type { ToolBridge } from "@xueness/tool-bridge";
import type { ApprovalBuckets } from "@xueness/plugin-sessions";

export function approvalReplayExtension(bridge: ToolBridge, approvals: ApprovalBuckets, enabled: (id: string) => boolean, toolOwner: (name: string) => string | null): AgentExtension {
  return {
    id: "sessions", capabilities: ["sessions.approvals"],
    async beforeRun(context) {
      const buckets = approvals.get(String(context.session.id));
      if (!buckets) return;
      const results = isDict(context.session.results) ? context.session.results : {};
      const messages = (Array.isArray(context.session.messages) ? context.session.messages : []).filter(isDict);
      for (const [kind, grants] of buckets) {
        for (const [cid, subject] of [...grants]) {
          if (context.signal.aborted || context.options.shouldStop?.()) return;
          const previous = results[cid]; const error = isDict(previous) && isDict(previous.error) ? previous.error : {};
          if (!isDict(previous) || !(previous.error === "denied" || error.code === "approval_required")) continue;
          const data = isDict(previous.data) ? previous.data : {};
          if (data.kind !== undefined && (data.kind !== kind || data.subject !== subject)) continue;
          const call = messages.flatMap((message) => Array.isArray(message.tool_calls) ? message.tool_calls : []).find((item) => isDict(item) && item.id === cid);
          if (!isDict(call) || !isDict(call.function) || typeof call.function.name !== "string") continue;
          const name = call.function.name; const owner = toolOwner(name);
          if (!owner || !enabled(owner)) continue;
          let input: unknown; try { input = pyJsonLoads(String(call.function.arguments ?? "{}")); } catch { continue; }
          if (!isDict(input)) continue;
          bridge.permissions.grantOnce(cid, kind, subject);
          const { _read_state, media, ...result } = await bridge.call({ id: cid, name, input }, { signal: context.signal }) as unknown as Row;
          bridge.permissions.revokeGrant(cid);
          grants.delete(cid);
          delete result.evidence_id; results[cid] = result;
          const alias = Object.entries(evidenceAliases(context.session)).find(([, id]) => id === cid)?.[0];
          if (result.ok === true) result.evidence_id = alias ?? null;
          const refs = media === undefined ? [] : await saveToolMedia(context.stateDir, String(context.session.id), media);
          for (const message of messages) if (message.role === "tool" && message.tool_call_id === cid) {
            message.content = pyJsonDumps(result);
            if (_read_state !== undefined) message._read_state = _read_state;
            if (refs.length) message._tool_media = refs;
          }
          if (!Array.isArray(context.session.approval_log)) context.session.approval_log = [];
          const log = context.session.approval_log as Row[];
          log.push({ at: new Date().toISOString().replace(/Z$/, "+00:00"), action: "consumed", kind, tool_call_id: cid, subject: pySlice(subject, 200) });
          log.splice(0, Math.max(0, log.length - 100)); await context.save();
        }
      }
    },
  };
}
