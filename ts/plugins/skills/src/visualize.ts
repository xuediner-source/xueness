/**
 * Inline visualizations (ZCode Gen UI) for the bundled visualize skill.
 *
 * The model writes an HTML fragment into the session's visualization
 * directory (`<state>/visualizations/<session id>`) and references it with a
 * `::visualize{"path": ...}` line; the web UI loads the rendered page from
 * `GET /api/visualizations`. Rendering is a port of the skill's
 * `scripts/render.py` (`_render_document`, `_read_fragment`,
 * `_default_title`, `calendar_script`): the same standalone document, byte
 * for byte, with the pinned vendor scripts inlined (`visualize-vendor.ts`).
 * The prompt section adapts ZCode's desktop context (`Interactive views`).
 */
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { embedVendorScripts, escapeHtml } from "./visualize-vendor.ts";

export { embedVendorScripts, escapeHtml, scriptStartTags, unescapeHtml } from "./visualize-vendor.ts";

export const VISUALIZE_SKILL = "visualize";
export const MAX_FRAGMENT_BYTES = 1_000_000;
const FRAGMENT_PLACEHOLDER = "<!--__INLINE_VISUALIZATION_FRAGMENT__-->";
const DOCUMENT_MARKUP = /<!doctype\s|<\s*(?:html|head|body)(?:\s|>)/i;
const RESOURCE_SOURCES = ["blob:", "data:", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://esm.sh", "https://fonts.bunny.net", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://unpkg.com"].join(" ");
export const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,
  `style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
  `img-src ${RESOURCE_SOURCES}`,
  `font-src ${RESOURCE_SOURCES}`,
  `media-src ${RESOURCE_SOURCES}`,
  "worker-src blob:",
  "connect-src blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
/** A srcdoc frame inherits the shell CSP, so the shell permits what the inner frame may load. */
export const SHELL_CSP = FRAME_CSP.replace("frame-src 'none'", "frame-src 'self'");

/** A fragment the renderer refuses (Python's `ValueError`/`UnicodeError`). */
export class VisualizationSourceError extends Error {
  override name = "VisualizationSourceError";
}

/** The session's durable visualization directory (outside every workspace). */
export function visualizationDirectory(stateDir: string, sessionId: string): string {
  return join(stateDir, "visualizations", sessionId);
}

/** ZCode's `buildDesktopContextSection`, interactive views only. */
export function interactiveViewsSection(directory: string): string {
  return [
    "# Xueness Desktop Context",
    "",
    "### Interactive views",
    "- This host supports Gen UI: completed assistant references to HTML fragments in the supplied session directory render inline.",
    `- Writable, durable visualization directory for this session: ${JSON.stringify(directory)}. Save inline fragments here, outside the project. Other paths cannot be rendered.`,
    "- Use the independent visualize skill for authoring instructions, styles and the restricted window.zcode bridge. Load the skill before generating an interactive view.",
  ].join("\n");
}

/** Python text mode: strict UTF-8 (a BOM stays) with universal newlines. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const text = (bytes: Uint8Array): string => STRICT_UTF8.decode(bytes).replace(/\r\n?/g, "\n");
const asset = (skillDir: string, name: string): string => text(readFileSync(join(skillDir, "assets", name)));

/** `_read_fragment`: a regular file of at most 1 MB holding an HTML fragment. */
export function readFragment(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new VisualizationSourceError(`source must be a regular file: ${path}`);
  if (stat.size > MAX_FRAGMENT_BYTES) throw new VisualizationSourceError("source fragment exceeds the 1 MB size limit");
  let fragment: string;
  try { fragment = text(readFileSync(path)); } catch (error) {
    if (error instanceof TypeError) throw new VisualizationSourceError("source is not valid UTF-8");
    throw error;
  }
  if (DOCUMENT_MARKUP.test(fragment)) throw new VisualizationSourceError("source must be an HTML fragment, not a complete document");
  return fragment;
}

/** `_default_title`: the file stem as capitalized words. */
export function defaultTitle(path: string): string {
  const name = basename(path), dot = name.lastIndexOf(".");
  const stem = dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
  const words = stem.replace(/[-_]/g, " ").split(/\s+/u).filter(Boolean);
  return words.map((word) => { const [first = "", ...rest] = word; return first.toUpperCase() + rest.join("").toLowerCase(); }).join(" ") || "Visualization";
}

/** `calendar_script`: the bundled element, registered before a fragment uses it. */
export function calendarScript(skillDir: string, fragment: string): string {
  if (!/(?<![\p{L}\p{N}_])viz-calendar(?![\p{L}\p{N}_])/iu.test(fragment)) return "";
  return "<script>" + asset(skillDir, "calendar.js").split("</script").join("<\\/script") + "</script>";
}

/** `_render_document`: the standalone page (shell plus sandboxed frame) for a fragment. */
export function renderVisualization(skillDir: string, fragment: string, title: string): string {
  const stylesheet = asset(skillDir, "visualize.css");
  const innerKit = asset(skillDir, "visualize.html");
  const hostBridge = asset(skillDir, "standalone-host-bridge.js").split("</script").join("<\\/script");
  const shell = asset(skillDir, "standalone-shell.js").split("</script").join("<\\/script");
  const innerHtml = embedVendorScripts(innerKit.split(FRAGMENT_PLACEHOLDER).join(calendarScript(skillDir, fragment) + fragment), join(skillDir, "assets", "vendor"));
  const documentTitle = escapeHtml(title);
  const frameHtml = `<!doctype html>
<html lang="en" data-visualize-standalone>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<title>${documentTitle}</title>
<style>${stylesheet}
html>body{padding:0}</style>
</head>
<body>
<script type="application/json" id="zcode-visualization-widget-state">__ZCODE_VISUALIZATION_WIDGET_STATE__</script>
<script>${hostBridge}</script>
${innerHtml}
</body>
</html>
`;
  return `<!doctype html>
<html lang="en" data-visualize-standalone>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${SHELL_CSP}">
<title>${documentTitle}</title>
<style>:root{color-scheme:light dark;background:light-dark(rgb(255 255 255), rgb(24 24 24))}html,body{margin:0}body{box-sizing:border-box;padding:1rem;background:inherit}iframe{display:block;width:100%;height:calc(100vh - 2rem);margin:0 auto;border:0}</style>
</head>
<body>
<iframe id="zcode-visualization" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${documentTitle}" data-srcdoc="${escapeHtml(frameHtml)}"></iframe>
<script>${shell}</script>
</body>
</html>
`;
}

/** `render`: the fragment file as a standalone page, titled after the file unless a title is given. */
export function renderVisualizationFile(skillDir: string, path: string, title?: string | null): string {
  return renderVisualization(skillDir, readFragment(path), title || defaultTitle(path));
}
