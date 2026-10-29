import { isDict } from "@xueness/contracts";
import { createExecTool, failure, shellQuote, type ToolDefinition } from "@xueness/engine-tools";
import { checkDelivery, type Row } from "./delivery.ts";
import { importContract, deliveryFingerprint } from "./delivery-verification.ts";
import { importProbePath } from "./import-probe.ts";
import type { PlanningToolsOptions } from "./task-tools.ts";

export function deliveryVerifyTool(options: PlanningToolsOptions): ToolDefinition<{ timeout_ms?: number }> {
  const invocation = (timeout: number) => {
    const spec = importContract(options.session() ?? {});
    return [process.execPath, importProbePath(), spec.silent ? "silent" : "output-allowed", String(timeout), ...spec.paths];
  };
  return {
    name: "delivery_verify", description: "Independently check declared saved outputs and explicitly requested Node module imports. Executes code through a real .mjs consumer under the normal exec permission. Never treat a CLI exit0 as proof of import or full correctness.",
    gate: "exec", mutating: true, concurrencySafe: false, alwaysLoad: true, requires: { exec: ["node"], fs: { read: ["workspace"], write: ["state", "temp"] } },
    inputSchema: { type: "object", additionalProperties: false, properties: { timeout_ms: { type: "integer", minimum: 1, maximum: 30000 } } },
    subject: input => invocation(input.timeout_ms ?? 10000).map(shellQuote).join(" "),
    async run(input, env) {
      const session = options.session();
      if (!session) return failure("invalid_argument", "delivery verification needs a session");
      if (options.enabled?.("files") === false) return failure("plugin_disabled", "files plugin disabled");
      const spec = importContract(session);
      const files = await checkDelivery(env.cwd, session, "", { enabled: id => options.enabled?.(id) !== false, canRead: () => true });
      let imports: Row = { status: "not_assessed", items: [] };
      if (spec.paths.length) {
        if (spec.paths.some(path => !deliveryFingerprint(env.cwd, path))) return failure("missing_import_target", "Save the declared module files before running import verification");
        const timeout = input.timeout_ms ?? 10000;
        const result = await createExecTool({ maxCaptureBytes: 64000 }).run({ argv: invocation(timeout), timeout_ms: timeout + 1000, auto_on_timeout: false }, env);
        try { const parsed: unknown = JSON.parse(result.output.replace(/^Exit code \d+\r?\n/, "")); if (isDict(parsed) && Array.isArray(parsed.items)) imports = parsed; }
        catch { imports = { status: "failed", items: spec.paths.map(path => ({ path, sha256: deliveryFingerprint(env.cwd, path), silent: spec.silent, passed: false, reason: result.output.slice(0, 1500) })) }; }
        imports = { ...imports, codeVersion: Number(session.delivery_code_version ?? 0) };
        session.delivery_verification = imports;
      }
      const missing = (Array.isArray(files.items) ? files.items : []).filter(isDict).filter(item => item.passed !== true).map(item => ({ path: item.path, missing: item.missing }));
      const data = { files: { status: files.status, missing }, imports }, ok = files.status !== "failed" && imports.status !== "failed";
      const diagnostics = (Array.isArray(imports.items) ? imports.items : []).filter(isDict).filter(item => item.passed !== true).map(item => `${item.path}: ${item.reason ?? "Import failed"}. ${item.stderr ?? ""}`).join("\n").slice(0, 1200);
      return { ok, output: `Files: ${files.status}. Missing: ${missing.map(item => item.path).join(", ") || "none"}. Imports: ${imports.status}.\n${diagnostics}\nThese checks do not establish full program correctness.`, data,
        ...ok ? {} : { error: { code: "delivery_verification_failed", message: "Saved outputs or independent module imports failed; use the recorded diagnostics" } } };
    },
  };
}
