/**
 * Inline visualizations (ZCode Gen UI): an assistant line
 * `::visualize{"path":"/abs/<title>.html"}` (optionally `"mode":"wide"`)
 * outside code fences shows that fragment, rendered by the server's visualize
 * skill (`GET /api/visualizations`), in a sandboxed frame. The historical
 * `::visualize{path="..."}` form is read too. While a reply streams the
 * reference stays hidden; the frame appears once the text settles.
 */
import React from "react";

export type VisualizationReference = { path: string; title?: string; wide: boolean };
export type ProseSegment = { kind: "markdown"; text: string } | { kind: "visualization"; reference: VisualizationReference };

const DIRECTIVE = /^[ \t]{0,3}::visualize(\{.*\})[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const ABSOLUTE = /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/;

function parseReference(body: string): VisualizationReference | null {
  let fields: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value)) fields = value as Record<string, unknown>;
  } catch {
    const pairs = [...body.slice(1, -1).matchAll(/([A-Za-z]+)="([^"]*)"/g)];
    if (pairs.length) fields = Object.fromEntries(pairs.map((pair) => [pair[1], pair[2]]));
  }
  const path = fields?.path;
  if (!fields || typeof path !== "string" || !ABSOLUTE.test(path) || !/\.html$/i.test(path)) return null;
  const title = typeof fields.title === "string" && fields.title.trim() ? fields.title.trim() : undefined;
  return { path, ...(title ? { title } : {}), wide: fields.mode === "wide" };
}

/** Prose split around visualization references; text without one is a single markdown segment. */
export function splitVisualizations(text: string): ProseSegment[] {
  if (!text.includes("::visualize")) return [{ kind: "markdown", text }];
  const segments: ProseSegment[] = [];
  let lines: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  const flush = () => {
    if (lines.some((line) => line.trim())) segments.push({ kind: "markdown", text: lines.join("\n") });
    lines = [];
  };
  for (const line of text.split("\n")) {
    const opener = FENCE.exec(line);
    if (fence) {
      if (opener && opener[1]![0] === fence.marker && opener[1]!.length >= fence.length && !line.slice(opener[0].length).trim()) fence = null;
      lines.push(line);
      continue;
    }
    if (opener) {
      fence = { marker: opener[1]![0]!, length: opener[1]!.length };
      lines.push(line);
      continue;
    }
    const directive = DIRECTIVE.exec(line);
    const reference = directive ? parseReference(directive[1]!) : null;
    if (reference) {
      flush();
      segments.push({ kind: "visualization", reference });
    } else lines.push(line);
  }
  flush();
  return segments;
}

/** The markdown alone (a streaming reply hides its references until it settles). */
export function proseWithoutVisualizations(segments: readonly ProseSegment[]): string {
  return segments.flatMap((segment) => (segment.kind === "markdown" ? [segment.text] : [])).join("\n\n");
}

export function visualizationUrl(reference: VisualizationReference): string {
  const query = new URLSearchParams({ path: reference.path });
  if (reference.title) query.set("title", reference.title);
  return `/api/visualizations?${query.toString()}`;
}

const HEIGHT_MESSAGE = "xueness-visualization-height";
const STATE_READ = "xueness-visualization-state-read";
const STATE_WRITE = "xueness-visualization-state-write";
const MAX_FRAME_HEIGHT = 10_000;

/**
 * The rendered page is served with `Content-Security-Policy: sandbox
 * allow-scripts`, so it has an opaque origin and its own `localStorage` throws.
 * Its shell therefore asks this page, which shares the app's origin, to keep
 * the widget state, and reports the height it measured so the frame can grow
 * or shrink to its content instead of a fixed box.
 */
function useVisualizationHost(frame: React.RefObject<HTMLIFrameElement | null>): number | null {
  const [height, setHeight] = React.useState<number | null>(null);
  React.useEffect(() => {
    const receive = (event: MessageEvent): void => {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const message = data as { type?: unknown; id?: unknown; key?: unknown; state?: unknown; height?: unknown };
      if (message.type === HEIGHT_MESSAGE) {
        if (typeof message.height === "number" && Number.isFinite(message.height) && message.height >= 0 && message.height <= MAX_FRAME_HEIGHT) {
          setHeight(Math.ceil(message.height));
        }
        return;
      }
      if (message.type !== STATE_READ && message.type !== STATE_WRITE) return;
      if (typeof message.id !== "number" || typeof message.key !== "string") return;
      let reply: Record<string, unknown>;
      if (message.type === STATE_READ) {
        let state: string | null = null;
        try { state = globalThis.localStorage.getItem(message.key); } catch { state = null; }
        reply = state === null ? { id: message.id } : { id: message.id, state };
      } else {
        let ok = false;
        if (typeof message.state === "string") {
          try { globalThis.localStorage.setItem(message.key, message.state); ok = true; } catch { ok = false; }
        }
        reply = { id: message.id, ok };
      }
      source.postMessage(reply, "*");
    };
    globalThis.addEventListener("message", receive);
    return () => globalThis.removeEventListener("message", receive);
  }, [frame]);
  return height;
}

/** The rendered page in a frame without same-origin access; the server's CSP sandboxes it as well. */
export const VisualizationFrame = React.memo(function VisualizationFrame({ reference, label }: { reference: VisualizationReference; label: string }): React.JSX.Element {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const height = useVisualizationHost(frame);
  return (
    <div
      className={`xn-viz${reference.wide ? " xn-viz--wide" : ""}`}
      style={height === null ? undefined : { height }}
      data-testid="xn-visualization"
    >
      <iframe
        ref={frame}
        className="xn-viz__frame"
        src={visualizationUrl(reference)}
        title={reference.title ?? label}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  );
});
