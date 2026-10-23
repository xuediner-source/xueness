/**
 * browser_navigate / inspect / snapshot / click / fill / screenshot with
 * Python's names, schemas, descriptions, `exec` gate, exact JSON subject and
 * argument bounds (`plugin._call`). Every call is approved on its own subject;
 * the worker never evaluates model-provided JavaScript.
 */
import { pyJsonDumps, pyLen, pySlice, type JsonSchema } from "@xueness/contracts";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import { formatSnapshot } from "./snapshot.ts";
import { publicHttpsShape } from "./url.ts";
import type { BrowserWorker } from "./worker.ts";

type Row = Record<string, unknown>;
export const MAX_SCREENSHOT_PNG = 450 * 1024;
export const ACTIONS = ["navigate", "inspect", "snapshot", "click", "fill", "screenshot"] as const;
export type BrowserAction = typeof ACTIONS[number];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREFIX = "data:image/png;base64,";

const PARAMETERS: Record<BrowserAction, [Row, string[]]> = {
  navigate: [{ url: { type: "string" } }, ["url"]],
  inspect: [{}, []],
  snapshot: [{}, []],
  click: [{ selector: { type: "string" } }, ["selector"]],
  fill: [{ selector: { type: "string" }, text: { type: "string" } }, ["selector", "text"]],
  screenshot: [{}, []],
};

/** `_tool_description`. */
export function toolDescription(action: BrowserAction): string {
  if (action === "snapshot") return "Read-only accessibility tree of the current public HTTPS page: role, accessible name, indentation, and stable refs on interactable elements. browser_click and browser_fill accept selector aria-ref=<ref> from this snapshot until the next snapshot or navigation. Does not change the page. Node and character limits are marked when truncated. Exact action approval required.";
  if (action === "click" || action === "fill") return `Browser ${action}; selector is a Playwright locator and may be aria-ref=<ref> from the latest browser_snapshot; exact action approval required`;
  return `Browser ${action}; exact action approval required`;
}

/** `_subject`: sort_keys, compact separators, ensure_ascii=False. */
export function browserSubject(value: Row): string {
  return pyJsonDumps(value, { sortKeys: true, separators: [",", ":"] });
}

export function schemaOf(action: BrowserAction): JsonSchema {
  const [properties, required] = PARAMETERS[action];
  return { type: "object", properties, required, additionalProperties: false } as JsonSchema;
}

/** `base64.b64decode(..., validate=True)`: CPython 3.11 `a2b_base64(strict_mode=True)` accepts it. */
export function b64Valid(text: string): boolean {
  const match = /^([A-Za-z0-9+/]*)(=*)$/.exec(text);
  if (!match) return false;
  const data = match[1]!.length, pads = match[2]!.length, rest = data % 4;
  if (pads && !data) return false;
  return rest === 0 || rest === 2 && pads === 2 || rest === 3 && pads === 1;
}

const valueError = (message: string): Error => Object.assign(new Error(message), { code: "invalid_argument" });
const runtimeError = (message: string): Error => Object.assign(new Error(message), { code: "execution_error" });

/** The argument checks `_call` makes after the gate and before the worker. */
export function checkArguments(action: BrowserAction, args: Row): void {
  if (action === "navigate" && !publicHttpsShape(args.url)) throw valueError("public HTTPS URL required");
  if ((action === "click" || action === "fill") && (typeof args.selector !== "string" || pyLen(args.selector) < 1 || pyLen(args.selector) > 1000)) throw valueError("bounded selector required");
  if (action === "fill" && (typeof args.text !== "string" || pyLen(args.text) > 5000)) throw valueError("bounded text required");
}

/** What `_call` makes of the worker's answer: screenshot bytes re-checked, snapshot formatted. */
export function shapeResult(action: BrowserAction, result: Row): Row {
  if (action === "screenshot" && result.ok) {
    const url = result.imageDataUrl;
    if (typeof url !== "string" || !url.startsWith(PREFIX)) throw runtimeError("browser worker returned an invalid screenshot");
    const encoded = url.slice(PREFIX.length);
    if (!b64Valid(encoded)) throw runtimeError("browser worker returned an invalid screenshot");
    const image = Buffer.from(encoded, "base64");
    if (image.length > MAX_SCREENSHOT_PNG || !image.subarray(0, 8).equals(PNG)) throw runtimeError("browser worker returned an invalid screenshot");
    return { ...result, imageDataUrl: PREFIX + image.toString("base64") };
  }
  if (action === "snapshot" && result.ok) {
    let formatted;
    try { formatted = formatSnapshot(result.nodes, { reportedTotal: result.totalNodes, reportedTruncated: result.truncated === true }); }
    catch { throw runtimeError("browser worker returned an invalid snapshot"); }
    return { ok: true, url: typeof result.url === "string" ? pySlice(result.url, 4096) : "", title: typeof result.title === "string" ? pySlice(result.title, 500) : "",
      tree: formatted.tree, nodeCount: formatted.nodeCount, totalNodes: formatted.totalNodes, truncated: formatted.truncated, charTruncated: formatted.charTruncated, untrusted: true };
  }
  return result;
}

export interface BrowserToolsOptions {
  /** The state directory's worker for this workspace, started on first use. */
  worker(root: string): Promise<BrowserWorker>;
}

export function browserTools(options: BrowserToolsOptions): ToolDefinition<Row>[] {
  return ACTIONS.map((action): ToolDefinition<Row> => ({
    name: "browser_" + action, description: toolDescription(action), inputSchema: schemaOf(action),
    gate: "exec", mutating: action === "click" || action === "fill", concurrencySafe: false, requires: {},
    subject: (input) => browserSubject({ action, ...input }), subjectKind: "text",
    async run(input, env): Promise<ToolResult> {
      checkArguments(action, input);
      const command: Row = { action, ...input };
      if (action === "screenshot") command.maxPngBytes = MAX_SCREENSHOT_PNG;
      const worker = await options.worker(env.cwd);
      const result = shapeResult(action, await worker.call(command));
      const output = pyJsonDumps(result);
      if (result.ok === true) return { ok: true, output, data: result };
      const message = typeof result.error === "string" ? result.error : "browser action failed";
      return { ok: false, output, data: result, error: { code: "execution_error", message } };
    },
  }));
}
