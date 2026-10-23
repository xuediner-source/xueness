/** Allowlisted compatibility evidence; arbitrary provider text is never persisted. */
import { createHash } from "node:crypto";
import { isDict, pyJsonDumps, pySlice } from "@xueness/contracts";
import { validateCompatibility } from "@xueness/providers";
import type { Dict } from "./profile-store.ts";

export const TEST_MODES = new Set(["conversation", "native_tool_call", "json_tool_call", "stream", "tool_roundtrip", "json_tool_roundtrip"]);
const STEPS = new Set(["conversation", "native_tool_call", "json_tool_call", "stream", "tool_result_followup"]);
const SAFE_ERRORS = new Set([
  "The provider returned no assistant text.", "The provider did not return exactly one function call.",
  "The provider returned an invalid function-call envelope.", "The provider returned an invalid function-call ID.",
  "The provider returned an unexpected function name or shape.", "The provider returned invalid function arguments.",
  "The provider returned arguments outside the required {a: 3, b: 4} schema.",
  "The provider returned no bounded JSON tool-call response.", "The provider did not return strict JSON.",
  "The provider returned JSON outside the required function name and argument schema.",
  "The endpoint did not return an SSE event stream.", "The SSE stream contained no assistant text delta.",
  "The provider did not echo the deterministic tool-result receipt.",
  "The endpoint rejected one or more request fields (HTTP 400). Change compatibility options explicitly and rerun this check.",
  "The provider compatibility request failed (details suppressed).", "Unsupported provider compatibility test mode.",
]);
export const safeError = (value: unknown): string => typeof value === "string" && SAFE_ERRORS.has(value) ? value : "The provider compatibility request failed (details suppressed).";
const int = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
export function optionsHash(options: unknown): string {
  return createHash("sha256").update(pyJsonDumps(validateCompatibility(options), { ensureAscii: false, sortKeys: true, separators: [",", ":"] })).digest("hex");
}
export function requiredModes(record: Dict): string[] {
  return ["conversation", "stream", record.toolCalling === "json" ? "json_tool_roundtrip" : "tool_roundtrip"];
}
export function hasProof(mode: string, result: Dict): boolean {
  const d = result.details;
  if (!isDict(d) || d.mode !== mode) return false;
  const count = mode.endsWith("roundtrip") ? 2 : 1;
  const requests = d.requests;
  if (d.requestCount !== count || !Array.isArray(requests) || requests.length !== count) return false;
  const expected = mode === "tool_roundtrip" ? ["native_tool_call", "tool_result_followup"] : mode === "json_tool_roundtrip" ? ["json_tool_call", "tool_result_followup"] : [mode];
  if (requests.some((r, i) => !isDict(r) || r.step !== expected[i] || !Array.isArray(r.fields) || r.fields.some((f: unknown) => typeof f !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(f)) || !r.fields.includes("messages") || !r.fields.includes("model"))) return false;
  const fields = requests[0].fields as string[];
  const args = d.arguments;
  const validArgs = isDict(args) && Object.keys(args).sort().join(",") === "a,b" && args.a === 3 && args.b === 4;
  if (mode === "conversation") return d.assistantTextReceived === true && !fields.includes("tools") && !fields.includes("stream");
  if (["native_tool_call", "json_tool_call"].includes(mode)) return !fields.includes("stream") && fields.includes("tools") === (mode === "native_tool_call") && d[mode === "json_tool_call" ? "jsonToolCallValidated" : "toolCallValidated"] === true && d.toolName === "xueness_fixture_add" && validArgs && d.fixtureExecuted === false;
  const streamed = d.sseContentType === true && d.doneReceived === true && int(d.deltaCount, 1, Number.MAX_SAFE_INTEGER) && int(d.deltaCharacters, 1, Number.MAX_SAFE_INTEGER);
  if (mode === "stream") return streamed && fields.includes("stream") && !fields.includes("tools");
  return mode.endsWith("roundtrip") && streamed && requests.every((r) => r.fields.includes("stream") && r.fields.includes("tools") === (mode === "tool_roundtrip")) && (mode !== "json_tool_roundtrip" || d.jsonToolCallValidated === true) && d.toolCallValidated === true && d.toolResultFollowupValidated === true && d.toolName === "xueness_fixture_add" && validArgs && d.fixtureExecuted === true;
}
export function publicCheck(mode: unknown, value: unknown): Dict | null {
  if (typeof mode !== "string" || !TEST_MODES.has(mode) || !isDict(value) || typeof value.ok !== "boolean") return null;
  const safe: Dict = { mode, ok: value.ok };
  for (const field of ["testedAt", "error"]) if (typeof value[field] === "string") safe[field] = field === "error" ? safeError(value[field]) : pySlice(value[field], 80);
  for (const field of ["requestCount", "latencyMs", "httpStatus", "failedStep"]) {
    const v = value[field];
    if ((field === "failedStep" && typeof v === "string" && STEPS.has(v)) || (field === "httpStatus" && int(v, 100, 599)) || (["requestCount", "latencyMs"].includes(field) && int(v, 0, 100000))) safe[field] = v;
  }
  if (isDict(value.details)) {
    const d = value.details;
    const clean: Dict = {};
    for (const f of ["assistantTextReceived", "toolCallValidated", "jsonToolCallValidated", "toolResultFollowupValidated", "sseContentType", "doneReceived", "fixtureExecuted"]) if (typeof d[f] === "boolean") clean[f] = d[f];
    for (const f of ["requestCount", "deltaCount", "deltaCharacters"]) if (int(d[f], 0, 100000)) clean[f] = d[f];
    if (int(d.httpStatus, 100, 599)) clean.httpStatus = d.httpStatus;
    if (typeof d.failedStep === "string" && STEPS.has(d.failedStep)) clean.failedStep = d.failedStep;
    if (Array.isArray(d.requests)) clean.requests = d.requests.slice(0, 3).filter((r) => isDict(r) && typeof r.step === "string" && STEPS.has(r.step) && Array.isArray(r.fields)).map((r) => ({ step: r.step.slice(0, 80), fields: r.fields.slice(0, 32).filter((f: unknown) => typeof f === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(f)) }));
    if (Object.keys(clean).length) safe.details = clean;
  }
  return safe;
}
export function storedCheck(mode: string, result: Dict, at: string): Dict {
  const d = isDict(result.details) ? result.details : {};
  const safe = publicCheck(mode, { ok: !!result.ok, details: d }) ?? {};
  const stored: Dict = { ok: !!result.ok, testedAt: at, requestCount: int(d.requestCount, 0, 100000) ? d.requestCount : 0, details: safe.details ?? {} };
  if (int(result.latencyMs, 0, 86400000)) stored.latencyMs = result.latencyMs;
  if (typeof result.error === "string") stored.error = safeError(result.error);
  if (int(d.httpStatus, 100, 599)) stored.httpStatus = d.httpStatus;
  if (typeof d.failedStep === "string" && STEPS.has(d.failedStep)) stored.failedStep = d.failedStep;
  return stored;
}
export function publicDiagnostics(record: Dict): Dict {
  const result: Dict = {};
  const diagnostics = record._compatibilityDiagnostics;
  const revision = record._profileRevision;
  if (isDict(diagnostics) && typeof revision === "string") {
    const groups: Dict[] = [];
    for (const [hash, group] of Object.entries(diagnostics)) {
      if (!/^[0-9a-f]{64}$/.test(hash) || !isDict(group) || group.profileRevision !== revision) continue;
      try {
        const compatibility = validateCompatibility(group.compatibility);
        if (optionsHash(compatibility) !== hash) continue;
        const checks = isDict(group.checks) ? Object.entries(group.checks).map(([m, c]) => publicCheck(m, c)).filter((v): v is Dict => v !== null) : [];
        groups.push({ optionsHash: hash, compatibility, checks: checks.sort((a, b) => String(a.mode).localeCompare(String(b.mode))) });
      } catch { /* Do not expose malformed or stale evidence. */ }
    }
    if (groups.length) result.compatibilityDiagnostics = groups.slice(-8);
  }
  const v = record._compatibilityVerification;
  if (isDict(v) && v.profileRevision === revision && typeof v.optionsHash === "string" && optionsHash(record.compatibility ?? {}) === v.optionsHash) {
    result.compatibilityVerification = { verifiedAt: v.verifiedAt, optionsHash: v.optionsHash, checks: Array.isArray(v.checks) ? v.checks.filter(isDict).map((c) => publicCheck(c.mode, c)).filter((v) => v !== null) : [] };
  }
  return result;
}
