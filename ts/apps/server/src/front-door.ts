/**
 * The Xueness HTTP server (formerly the front door in front of `xueness/web.py`).
 *
 * It answers the web UI bundle, its status route, `/api/csrf`, `/api/health`
 * and every plugin route with the same framing checks, guards, headers and
 * error envelope as `web.py`. A path nobody owns gets web.py's 404 envelope.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { bodyLimitFor, pyStrip } from "@xueness/contracts";
import { checkRequest } from "./guards.ts";
import {
  applyHeadLimits, expireHead, frontSocketHead, HEADER_DEADLINE_MS, HEADER_IDLE_MS, headReceived, isHeadTimeout, trackHeadLimits,
  type HeadOutcomes,
} from "./head-limits.ts";
import { requestPath } from "./py-url.ts";
import { headRefusal, refuse } from "./request-head.ts";
import { FRAMING_ERRORS, protocolReply, sendBody, sendJson, writeProtocolError } from "./respond.ts";
import { ROOT_FILES, isStaticPath, serveStatic } from "./static.ts";
import { apiLocation, IntakeError, readApiBody, type ApiDispatcher } from "./api-body.ts";
import { isAsyncBody, sendStream } from "./stream-response.ts";

export const STATUS_PATH = "/api/front-door/status";
export const FRONT_DOOR_VERSION = "0.2.1";

/** Settings that can change while the front door runs (see `configure`). */
export interface FrontDoorSettings {
  /** Desktop mode: every request must carry X-Xueness-Desktop-Token. */
  desktopToken?: string | null;
  webappDir?: string;
  /** `_HEADER_IDLE_SECONDS` in milliseconds (default 15 s). */
  headerIdleMs?: number;
  /** `_HEADER_DEADLINE_SECONDS` in milliseconds (default 20 s). */
  headerDeadlineMs?: number;
}

export interface FrontDoorOptions extends FrontDoorSettings {
  webappDir: string;
  /** Manifest route family -> owning plugin (status only). */
  families?: Record<string, string>;
  describeBackend?: () => Record<string, unknown>;
  /** How often head deadlines are checked (default 1 s; Node's own default is 30 s). */
  connectionsCheckingIntervalMs?: number;
  api?: ApiDispatcher;
  bodyIdleMs?: number;
  bodyDeadlineMs?: number;
}

export interface FrontDoorStats {
  /** Requests answered (routes, static files, core replies and 404s). */
  ts: number;
  /** Requests refused by the front door itself: unparsable, timed-out or refused heads (HEAD, HTTP/2+, limits). */
  protocolErrors: number;
  /** Connections closed without an answer because nothing arrived in time. */
  silentCloses: number;
}

export interface FrontDoor extends NetServer {
  /** Change settings live: the token and bundle apply to the next request, limits to the next head. */
  configure(update: FrontDoorSettings): void;
  stats(): FrontDoorStats;
  /** Destroy every tracked TCP front socket (Bun net.Server has no closeAllConnections). */
  closeAllConnections(): void;
}

/** Node compares these as whole milliseconds; 0 would switch a limit off. */
function limitMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`head limit must be a positive number of ms, got ${value}`);
  return Math.max(1, Math.round(value));
}

export interface FramingError {
  status: number;
  code: string;
  message: string;
}

/** `_prepare_read` and `_declared_length` for a read request. */
export function readFraming(req: IncomingMessage, path: string): { error?: FramingError; bodyUnread: boolean } {
  const transfers = req.headersDistinct["transfer-encoding"] ?? [];
  if (transfers.some((value) => pyStrip(value))) return { error: FRAMING_ERRORS.lengthRequired, bodyUnread: true };
  const lengths = req.headersDistinct["content-length"] ?? [];
  if (!lengths.length) return { bodyUnread: false };
  const invalid = { error: FRAMING_ERRORS.invalidLength, bodyUnread: true };
  if (lengths.length !== 1) return invalid;
  const raw = pyStrip(lengths[0] as string);
  if (raw.length > 10 || !/^[0-9]+$/.test(raw) || (raw.length > 1 && raw.startsWith("0"))) return invalid;
  const length = Number(raw);
  if (length > bodyLimitFor(path)) return { error: FRAMING_ERRORS.tooLarge, bodyUnread: true };
  return { bodyUnread: length > 0 };
}

export const TS_ROUTES: readonly string[] = Object.freeze([
  "GET /", "GET /index.html", "GET /assets/*", ...Object.keys(ROOT_FILES).map((path) => `GET ${path}`), `GET ${STATUS_PATH}`,
  "GET /api/csrf", "GET /api/health", "GET /healthz",
]);

let frontDebugWired = false;
export function createFrontDoor(options: FrontDoorOptions): FrontDoor {
  /** web.py's own GET routes, answered before the plugin dispatch. */
  const coreReply = (method: string, path: string): [number, Record<string, unknown>] | null => {
    if (method !== "GET") return null;
    if (path === "/api/csrf" && options.api) return [200, { csrfToken: options.api.csrfToken }];
    if (path === "/api/health" || path === "/healthz") return [200, { ok: true, service: "xueness-web" }];
    return null;
  };
  const settings = {
    desktopToken: options.desktopToken || null,
    webappDir: options.webappDir,
    headerIdleMs: limitMs(options.headerIdleMs ?? HEADER_IDLE_MS),
    headerDeadlineMs: limitMs(options.headerDeadlineMs ?? HEADER_DEADLINE_MS),
  };
  const counts: FrontDoorStats = { ts: 0, protocolErrors: 0, silentCloses: 0 };
  const outcomes: HeadOutcomes = { timedOut: () => void counts.protocolErrors++, closedSilently: () => void counts.silentCloses++ };
  const limits = () => ({ idleMs: settings.headerIdleMs, deadlineMs: settings.headerDeadlineMs });
  const started = Date.now();
  const status = (): Record<string, unknown> => ({
    ok: true,
    service: "xueness-front-door",
    version: FRONT_DOOR_VERSION,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    backend: { kind: "ts", pid: process.pid, ...options.describeBackend?.() },
    routes: { ts: [...TS_ROUTES, ...(options.api?.routes ?? [])], families: options.families ?? null },
    requests: { ...counts },
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { path } = requestPath(req.url ?? "/");
    const location = apiLocation(req.url ?? "/");
    const apiOwned = options.api?.owns(req.method ?? "GET", location.parts) ?? false;
    const staticGet = !apiOwned && req.method === "GET" && (isStaticPath(path) || path === STATUS_PATH);
    counts.ts++;
    const framing = readFraming(req, path);
    if (framing.error) {
      sendJson(res, framing.error.status, { error: framing.error.message, code: framing.error.code }, { close: true });
      return;
    }
    const mutation = req.method !== "GET";
    let close = framing.bodyUnread;
    const failure = checkRequest(req.headersDistinct, { desktopToken: settings.desktopToken,
      ...(mutation && options.api ? { csrfToken: options.api.csrfToken } : {}),
    });
    if (failure) {
      sendJson(res, failure.status, failure.payload, { close });
      return;
    }
    if (!staticGet) {
      const controller = new AbortController(), abort = () => controller.abort();
      res.once("close", abort); req.once("aborted", abort);
      try {
        const body = mutation ? await readApiBody(req, res, { idleMs: options.bodyIdleMs, deadlineMs: options.bodyDeadlineMs, lossless: options.api?.lossless?.(req.method ?? "GET", location.parts) === true }) : { data: {}, raw: Buffer.alloc(0), close };
        close = body.close;
        const hostHeader = req.headers["x-xueness-host-capability"];
        const result = !apiOwned ? coreReply(req.method ?? "GET", path) : await options.api!.dispatch(req.method ?? "GET", location.parts, location.query, body.data, { accept: req.headers.accept, lastEventId: req.headersDistinct["last-event-id"]?.join(", "), signal: controller.signal, hostCapability: Array.isArray(hostHeader) ? hostHeader[0] ?? null : hostHeader ?? null, ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}) });
        if (result?.[2] && isAsyncBody(result[1])) await sendStream(res, result[0], result[1], result[2], controller.signal, { close });
        else if (result?.[2]) sendBody(res, result[0], Buffer.isBuffer(result[1]) ? result[1] : Buffer.from(String(result[1])), result[2], { close, ...(result[3] ? { headers: result[3] } : {}) });
        else if (result) sendJson(res, result[0], result[1], { close });
        // web.py: the write path's 404 carries a code, the read path's does not.
        else sendJson(res, 404, mutation ? { error: "not found", code: "not_found" } : { error: "not found" }, { close });
      } catch (error) {
        if (error instanceof IntakeError) sendJson(res, error.status, { code: error.code, error: error.message }, { close: true });
        else throw error;
      } finally { controller.abort(); res.off("close", abort); req.off("aborted", abort); }
      return;
    }
    if (path === STATUS_PATH) {
      sendJson(res, 200, status(), { close });
      return;
    }
    const result = await serveStatic(path, settings.webappDir, options.api?.asset);
    if (!result) sendJson(res, 404, { error: "not found" }, { close });
    else if (result.kind === "file") sendBody(res, 200, result.body, result.contentType, { close });
    else sendJson(res, result.status, result.payload, { close });
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (process.env.XUENESS_HEAD_DEBUG) {
      process.stderr.write(`[front-debug] req ${req.method} ${req.url} t=${Date.now() % 100000}\n`);
      res.once("finish", () => process.stderr.write(`[front-debug] res ${req.method} ${req.url} -> ${res.statusCode} t=${Date.now() % 100000}\n`));
    }
    headReceived(req, res);
    const refusal = headRefusal(req);
    if (refusal) {
      counts.protocolErrors++;
      refuse(res, refusal);
      return;
    }
    handle(req, res).catch((error: unknown) => {
      process.stderr.write(`front door error: ${error instanceof Error ? error.stack : String(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error", code: "internal_error" }, { close: true });
      else res.destroy();
    });
  };

  const server = createServer({
    maxHeaderSize: 128 * 1024,
    headersTimeout: settings.headerDeadlineMs,
    // Bodies are timed by `readApiBody` (web.py `_BODY_IDLE_SECONDS`, `_BODY_DEADLINE_SECONDS`).
    requestTimeout: 0,
    keepAliveTimeout: Math.min(settings.headerIdleMs, settings.headerDeadlineMs),
    keepAliveTimeoutBuffer: 0,
    connectionsCheckingInterval: options.connectionsCheckingIntervalMs ?? 1000,
  }, onRequest);
  trackHeadLimits(server, limits, outcomes);
  server.on("checkContinue", onRequest);
  server.on("checkExpectation", onRequest);
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    if (error.code === "ECONNRESET" || error.code === "EPIPE") {
      socket.destroy();
      return;
    }
    if (isHeadTimeout(error)) {
      expireHead(socket, outcomes);
      return;
    }
    counts.protocolErrors++;
    const reply = protocolReply(error);
    writeProtocolError(socket, reply.status, reply);
  });

  const configure = (update: FrontDoorSettings): void => {
    if (update.desktopToken !== undefined) settings.desktopToken = update.desktopToken || null;
    if (update.webappDir !== undefined) settings.webappDir = update.webappDir;
    if (update.headerIdleMs !== undefined) settings.headerIdleMs = limitMs(update.headerIdleMs);
    if (update.headerDeadlineMs !== undefined) settings.headerDeadlineMs = limitMs(update.headerDeadlineMs);
    applyHeadLimits(server, limits());
  };
  const sockets = new Set<Socket>();
  // The TCP front owns each socket before the HTTP parser attaches: Bun's
  // parser never surfaces head bytes (nor its own timeouts) to JavaScript, so
  // heads are counted and timed here; Node's parser runs on as before.
  const front = createNetServer((socket: Socket) => {
    sockets.add(socket);
    if (process.env.XUENESS_HEAD_DEBUG && !frontDebugWired) {
      frontDebugWired = true;
      front.on("close", () => process.stderr.write(`[front-debug] FRONT CLOSED t=${Date.now() % 100000}\n`));
      front.on("error", (error) => process.stderr.write(`[front-debug] FRONT ERROR ${String(error)} t=${Date.now() % 100000}\n`));
    }
    if (process.env.XUENESS_HEAD_DEBUG) {
      process.stderr.write(`[front-debug] conn t=${Date.now() % 100000}\n`);
      socket.on("close", (hadError) => process.stderr.write(`[front-debug] close hadError=${hadError} destroyed=${socket.destroyed} t=${Date.now() % 100000}\n`));
      socket.on("error", (error) => process.stderr.write(`[front-debug] error ${String(error)}\n`));
    }
    socket.once("close", () => sockets.delete(socket));
    frontSocketHead(socket, limits, outcomes);
    server.emit("connection", socket);
  });
  return Object.assign(front, {
    configure,
    stats: (): FrontDoorStats => ({ ...counts }),
    /** Bun's `net.Server` has none of its own; the front tracks every socket. */
    closeAllConnections: (): void => { for (const socket of sockets) socket.destroy(); },
  });
}
