/**
 * Antigravity-style single-step `run_workflow` tool and parent-turn completion
 * notice helper for backgrounded dynamic script runs.
 */
import { readFileSync } from "node:fs";
import { pyJsonDumps, PyValueError, type JsonSchema } from "@xueness/contracts";
import type { ToolDefinition } from "@xueness/engine-tools";
import { compileDynamicWorkflow } from "./dynamic-compile.ts";
import { blockedReminderFor } from "./dynamic-blocked-reminder.ts";
import type { DynamicWorkflowService } from "./dynamic-service.ts";
import type { DynamicWorkflowRun } from "./dynamic-types.ts";
import { isInside, resolvePath, type Row } from "./plan.ts";

const NOTIFIED_STATES = new Set(["completed", "failed", "cancelled", "interrupted", "paused", "awaiting_user"]);

export function dynamicNoticeKey(run: Pick<DynamicWorkflowRun, "status" | "updatedAt" | "events">): string | null {
  if (!NOTIFIED_STATES.has(run.status)) return null;
  const lastSeq = run.events.at(-1)?.seq ?? 0;
  return `${run.status}:${lastSeq}`;
}

export function summarizeDynamicRun(run: DynamicWorkflowRun, backgrounded: boolean): Record<string, unknown> {
  const logs = run.events.filter((event) => event.type === "log" && typeof event.message === "string").slice(-30).map((event) => event.message);
  const phases = run.events.filter((event) => event.type === "phase" && typeof event.phase === "string").map((event) => event.phase);
  const actors = Object.values(run.actors).map((actor) => ({
    id: actor.id,
    name: actor.name,
    role: actor.persona.role,
    model: actor.persona.model ?? "inherit",
    asks: actor.asks,
  }));
  const reminder = blockedReminderFor(run);
  return {
    ok: run.status !== "failed",
    runId: run.id,
    name: run.name,
    ...(run.description === undefined ? {} : { description: run.description }),
    status: run.status,
    backgrounded,
    ...(run.phase === undefined ? {} : { phase: run.phase }),
    phases,
    actors,
    logs,
    reports: run.reports,
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(reminder ? { blockedReminder: reminder } : {}),
  };
}

function readScriptFromWorkspace(root: string, scriptPath: string): string {
  const resolvedRoot = resolvePath(root);
  const candidate = resolvePath(scriptPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(scriptPath) ? scriptPath : `${resolvedRoot}/${scriptPath}`);
  if (!isInside(candidate, resolvedRoot)) {
    throw new PyValueError("scriptPath must resolve inside the active session workspace");
  }
  const source = readFileSync(candidate, "utf8");
  if (!source.trim() || source.length > 32_000) {
    throw new PyValueError("scriptPath file must contain 1..32000 characters");
  }
  return source;
}

export function createRunWorkflowTool(options: {
  service(): DynamicWorkflowService | undefined;
  session(): Row | null;
  allowRealHost(): boolean;
}): ToolDefinition<Row> {
  const inputSchema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      script: { type: "string", minLength: 1, maxLength: 32000, description: "Inline TypeScript workflow script using phase, log, agent, ask, parallel, pipeline, files, trajectory, report, and hole. Set exactly one of script or scriptPath." },
      scriptPath: { type: "string", minLength: 1, maxLength: 512, description: "Path of a TypeScript workflow script inside the session workspace. Set exactly one of script or scriptPath." },
      name: { type: "string", minLength: 1, maxLength: 120, description: "Short workflow title." },
      description: { type: "string", minLength: 1, maxLength: 500, description: "Brief summary of the workflow goal." },
      args: { description: "Optional JSON arguments exposed inside the script via the global args binding." },
      maxConcurrency: { type: "integer", minimum: 1, maximum: 8, description: "Maximum concurrent agent/read operations (1..8, default 4)." },
      writable: { type: "boolean", description: "Allow workflow actors to edit files in their workspace (default false)." },
      allowReal: { type: "boolean", description: "Opt in to live model calls for agents (defaults to true when host model execution is enabled)." },
      waitMsBeforeAsync: { type: "integer", minimum: 0, maximum: 10000, description: "Milliseconds (0..10000, default 5000) to wait for completion before backgrounding." },
    },
  };

  return {
    name: "run_workflow",
    description: "Compile and run a dynamic TypeScript orchestration workflow in one step (Antigravity-style). Supports parallel(items, fn) fan-outs, pipeline(items, fn) staged pipelines, persistent and single-shot agent({ system, role, model }) calls, typed ask<T>, trajectory(filter), files.read/glob, phase, log, report, and hole. Waits up to waitMsBeforeAsync (default 5000ms) to return inline results or backgrounds with completion notification.",
    inputSchema,
    gate: "exec",
    mutating: true,
    concurrencySafe: false,
    requires: { exec: ["*"], fs: { read: ["state", "workspace"], write: ["state"] } },
    subject: (input) => pyJsonDumps(input, { ensureAscii: false, sortKeys: true, separators: [",", ":"] }),
    async run(input) {
      const service = options.service();
      const session = options.session();
      if (!service || !session || typeof session.id !== "string" || typeof session.root !== "string") {
        throw new TypeError("dynamic script workflow execution is unavailable in this host");
      }
      const hasScript = typeof input.script === "string" && input.script.length > 0;
      const hasPath = typeof input.scriptPath === "string" && input.scriptPath.length > 0;
      if (hasScript === hasPath) {
        throw new PyValueError("provide exactly one of script or scriptPath");
      }
      const source = hasScript ? (input.script as string) : readScriptFromWorkspace(session.root, input.scriptPath as string);
      const compiled = compileDynamicWorkflow(source);
      if (compiled.diagnostics.length) {
        const first = compiled.diagnostics[0]!;
        throw new PyValueError(`workflow compilation failed at ${first.line}:${first.column} (${first.code}): ${first.message}`);
      }
      const needsModel = compiled.sites.some((site) => site.kind === "ask");
      const allowReal = typeof input.allowReal === "boolean" ? input.allowReal : (needsModel && options.allowRealHost());
      const created = await service.create(session.id, source, {
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(typeof input.description === "string" ? { description: input.description } : {}),
        ...(input.args === undefined ? {} : { args: input.args }),
        maxConcurrency: typeof input.maxConcurrency === "number" ? input.maxConcurrency : 4,
        ...(typeof input.writable === "boolean" ? { writable: input.writable } : {}),
      });
      await service.start(session.id, created.id, { digest: created.digest, confirmed: true, allowReal });
      const waitMs = typeof input.waitMsBeforeAsync === "number" ? input.waitMsBeforeAsync : 5000;
      const settled = await service.wait(created.id, waitMs);
      const latest = await service.get(session.id, created.id);
      if (settled) {
        const key = dynamicNoticeKey(latest);
        if (key) service.markNoticed(latest.id, key);
      }
      const data = summarizeDynamicRun(latest, !settled);
      return { ok: true, output: JSON.stringify(data), data };
    },
  };
}
