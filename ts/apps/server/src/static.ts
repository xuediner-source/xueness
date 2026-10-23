/**
 * The web UI bundle, ported from `do_GET` in `xueness/web.py`: `/` and
 * `/index.html`, Vite's named files under `/assets/` (name pattern, suffix
 * allowlist, the resolved file must sit directly in the assets directory),
 * and a fixed allowlist of root files. Not a general file server.
 *
 * Content types are a fixed table instead of the host's mimetypes database,
 * so fonts are `font/*` on every machine (Python answers
 * application/octet-stream where /etc/mime.types lacks them).
 */
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

export const ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".ico": "image/vnd.microsoft.icon", ".wasm": "application/wasm", ".mp3": "audio/mpeg",
});

export const ROOT_FILES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  "/xueness-mark.svg": ["xueness-mark.svg", "image/svg+xml"],
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/icon_512@2x.png": ["icon_512@2x.png", "image/png"],
  "/third-party-notices.txt": ["third-party-notices.txt", "text/plain; charset=utf-8"],
});

export type StaticResponse =
  | { kind: "file"; status: 200; body: Buffer; contentType: string }
  | { kind: "error"; status: 404 | 503; payload: { error: string } };

export function isStaticPath(path: string): boolean {
  return path === "/" || path === "/index.html" || path.startsWith("/assets/") || path in ROOT_FILES;
}

/** `Path.resolve()` (non-strict): real path of the deepest existing ancestor. */
async function resolvePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await resolvePath(parent), basename(absolute));
  }
}

const NOT_FOUND = { kind: "error", status: 404, payload: { error: "not found" } } as const;

async function fileOrNotFound(path: string, contentType: string): Promise<StaticResponse> {
  try {
    return { kind: "file", status: 200, body: await readFile(path), contentType };
  } catch {
    return NOT_FOUND;
  }
}

export async function serveStatic(path: string, webappDir: string): Promise<StaticResponse | null> {
  if (path === "/" || path === "/index.html") {
    try {
      return { kind: "file", status: 200, body: await readFile(join(webappDir, "index.html")), contentType: "text/html; charset=utf-8" };
    } catch {
      return { kind: "error", status: 503, payload: { error: "ui asset missing" } };
    }
  }
  if (path.startsWith("/assets/")) {
    const name = path.slice("/assets/".length);
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) return NOT_FOUND;
    const root = await resolvePath(join(webappDir, "assets"));
    const asset = await resolvePath(join(root, name));
    const type = ASSET_TYPES[extname(basename(asset))];
    if (dirname(asset) !== root || !type) return NOT_FOUND;
    return fileOrNotFound(asset, type);
  }
  const entry = ROOT_FILES[path];
  if (entry) {
    const root = await resolvePath(webappDir);
    const file = await resolvePath(join(root, entry[0]));
    if (dirname(file) !== root) return NOT_FOUND;
    return fileOrNotFound(file, entry[1]);
  }
  return null;
}
