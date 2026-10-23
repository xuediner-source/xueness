/**
 * Built-in prompt commands shipped with the plugin (Python `builtin_prompts.py`,
 * currently `/init`). They own their invocation name outright and need a
 * workspace root before there is anything to point a prompt at.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pySlice, pyStr, pyStrip, pyTruthy } from "@xueness/contracts";
import { INIT_ARGUMENT_HEADER, INIT_ARGUMENT_HINT, INIT_DESCRIPTION, INIT_TEMPLATE } from "./builtin-text.ts";

export type Language = "zh" | "en";
export const BUILTIN_SOURCE = "builtin";
export const INIT_COMMAND = "init";
export const BUILTIN_NAMES: ReadonlySet<string> = new Set([INIT_COMMAND]);
const MAX_ARGUMENT_CHARS = 3000;
const ORIGIN = fileURLToPath(import.meta.url);
const text = (value: unknown): string => pyStr(pyTruthy(value) ? value : "");

/** `normalize_language`: the request value, then `XUENESS_LANGUAGE`, then Chinese. */
export function normalizeLanguage(value?: unknown, env: NodeJS.ProcessEnv = process.env): Language {
  for (const candidate of [value, env.XUENESS_LANGUAGE]) {
    const lowered = pyStrip(text(candidate)).toLowerCase();
    if (lowered === "zh" || lowered === "en") return lowered;
    if (lowered.startsWith("zh") || lowered.startsWith("en")) return lowered.slice(0, 2) as Language;
  }
  return "zh";
}

export const isBuiltinName = (name: unknown): boolean => BUILTIN_NAMES.has(text(name).replace(/^\/+/, ""));

/** `render`: the fixed prompt with its workspace and target, the arguments appended below as data. */
export function render(name: unknown, args: unknown = "", language?: unknown, root?: string | null, env?: NodeJS.ProcessEnv): string | null {
  if (text(name) !== INIT_COMMAND || root == null) return null;
  const lang = normalizeLanguage(language, env);
  const target = join(root, "AGENTS.md");
  // Python `str.replace`: literal text, no `$&` patterns.
  let body = INIT_TEMPLATE[lang].join("\n").replaceAll("__XUENESS_WORKSPACE__", () => root).replaceAll("__XUENESS_TARGET__", () => target);
  const note = pySlice(pyStrip(text(args)), MAX_ARGUMENT_CHARS);
  if (note) body += "\n\n" + INIT_ARGUMENT_HEADER[lang] + "\n```text\n" + note + "\n```";
  return body;
}

/** `rows`: one listing row per built-in, only once a workspace root exists. */
export function builtinRows(language?: unknown, root?: string | null, env?: NodeJS.ProcessEnv): Record<string, unknown>[] {
  if (root == null) return [];
  const lang = normalizeLanguage(language, env);
  return [...BUILTIN_NAMES].sort().flatMap((name) => {
    const body = render(name, "", lang, root, env);
    if (body === null) return [];
    return [{ id: name, name, description: INIT_DESCRIPTION[lang], argumentHint: INIT_ARGUMENT_HINT[lang], model: "", frontmatterKeys: [],
      source: BUILTIN_SOURCE, scope: "builtin", path: ORIGIN, directory: dirname(ORIGIN), rootPath: root, bytes: Buffer.byteLength(body, "utf8"), body,
      shadowed: false, shadowedBy: null, language: lang, builtinName: name }];
  });
}
