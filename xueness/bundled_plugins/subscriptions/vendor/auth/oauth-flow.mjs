// Adapted from dsh-plugin-suite, MIT, copyright 2026 xuediner-source and contributors.
// Source commit 3e70973ecd390d93e5b092e14f09026c1bef9df2. See LICENSE-MIT.txt.
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_FLOW_TIMEOUT_MS = 180_000;
const MAX_CODE_LENGTH = 16 * 1024;
const SUCCESS_PAGE = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Login successful</title></head><body><h1>Login successful</h1><p>You can close this tab and return to Xueness.</p></body></html>";

function base64url(buffer) {
	return buffer.toString("base64url");
}

export function createPkce() {
	const verifier = base64url(randomBytes(32));
	return {
		verifier,
		challenge: base64url(createHash("sha256").update(verifier).digest())
	};
}

function randomToken(bytes = 32) {
	return base64url(randomBytes(bytes));
}

function randomHex(bytes = 8) {
	return randomBytes(bytes).toString("hex");
}

function safeFailurePage(detail) {
	const text = String(detail).slice(0, 500).replace(/[<>&]/g, "");
	return `<!doctype html><html><head><meta charset="utf-8"><title>Login failed</title></head><body><h1>Login failed</h1><p>${text}</p></body></html>`;
}

function securityHeaders(contentType) {
	return {
		"content-type": contentType,
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	};
}

/** The loopback host names a listener can serve without resolving arbitrary DNS. */
function listenHosts(host) {
	if (host === "localhost") return ["127.0.0.1", "::1"];
	if (host === "127.0.0.1") return [host];
	throw new Error("OAuth callback listener must bind to localhost or 127.0.0.1");
}

function familyUnavailable(error) {
	return error?.code === "EADDRNOTAVAIL" || error?.code === "EPROTONOSUPPORT" || error?.code === "EAFNOSUPPORT";
}

function closeServers(servers) {
	for (const server of servers) {
		if (server.listening) server.close();
		server.closeAllConnections?.();
	}
}

async function listen(handler, spec) {
	const hosts = listenHosts(spec.host);
	if (!Array.isArray(spec.ports) || spec.ports.length === 0 || spec.ports.some((port) => !Number.isInteger(port) || port < 0 || port > 65535)) {
		throw new Error("OAuth callback listener ports must be valid TCP port numbers");
	}
	const candidates = spec.ports.flatMap((port) => port === 0 ? [0, 0, 0] : [port]);
	let lastError;
	for (const candidate of candidates) {
		const servers = [];
		let port = candidate;
		let unusable = false;
		for (const host of hosts) {
			const server = createServer(handler);
			try {
				await new Promise((resolve, reject) => {
					const onError = (error) => reject(error);
					server.once("error", onError);
					server.listen(port, host, () => {
						server.removeListener("error", onError);
						resolve();
					});
				});
				const address = server.address();
				if (address === null) throw new Error(`callback server on ${host}:${port} has no address`);
				if (port === 0) port = address.port;
				servers.push(server);
			} catch (error) {
				server.close();
				if (familyUnavailable(error)) continue;
				lastError = error;
				unusable = true;
				break;
			}
		}
		if (unusable || servers.length === 0) {
			closeServers(servers);
			continue;
		}
		return { servers, port };
	}
	throw lastError instanceof Error ? lastError : new Error(`callback server could not listen on ${spec.host} (ports ${spec.ports.join(", ")})`);
}

function secureEquals(left, right) {
	const a = Buffer.from(String(left));
	const b = Buffer.from(String(right));
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One OAuth callback attempt per provider, held until exchange and persistence
 * finish. The callback listener only owns the authorization-code wait; its
 * AbortSignal also fences later token exchange and storage work.
 */
export class OAuthFlowManager {
	attempts = new Map();
	starting = new Map();

	isBusy(provider) {
		return this.attempts.has(provider) || this.starting.has(provider);
	}

	pending(provider) {
		return this.attempts.get(provider);
	}

	async start(provider, spec) {
		if (this.isBusy(provider)) throw new Error(`a ${provider} login attempt is already in progress`);
		if (this.attempts.size + this.starting.size >= 3) throw new Error("too many concurrent login attempts in progress (max 3)");
		let resolveStarting;
		const reservation = { cancelled: false, done: new Promise((resolve) => { resolveStarting = resolve; }) };
		this.starting.set(provider, reservation);
		let bound;
		try {
			const input = {
				redirectUri: "",
				state: randomToken(16),
				pkce: createPkce(),
				nonce: randomHex(8)
			};
			const timeoutMs = spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
			let resolveCode;
			let rejectCode;
			const codePromise = new Promise((resolve, reject) => {
				resolveCode = resolve;
				rejectCode = reject;
			});
			void codePromise.catch(() => undefined);
			let settled = false;
			let codeReceived = false;
			let finished = false;
			let timer;
			let servers = [];
			const controller = new AbortController();
			const close = () => {
				if (timer !== undefined) clearTimeout(timer);
				closeServers(servers);
				servers = [];
			};
			const settle = (error, code) => {
				if (settled) return;
				settled = true;
				close();
				if (error !== undefined) {
					controller.abort(error);
					if (!codeReceived) rejectCode(error);
				} else if (code !== undefined) {
					codeReceived = true;
					resolveCode(code);
				}
			};
			const handler = (request, response) => {
				let url;
				try {
					url = new URL(request.url ?? "/", "http://localhost");
				} catch {
					response.writeHead(400, securityHeaders("text/plain; charset=utf-8")).end();
					return;
				}
				if (url.pathname !== spec.callbackPath) {
					response.writeHead(404, securityHeaders("text/plain; charset=utf-8")).end("not found");
					return;
				}
				if (request.method !== "GET") {
					response.writeHead(405, securityHeaders("text/plain; charset=utf-8")).end("method not allowed");
					return;
				}
				const states = url.searchParams.getAll("state");
				if (states.length !== 1 || !secureEquals(states[0], input.state)) {
					response.writeHead(400, securityHeaders("text/plain; charset=utf-8")).end("state mismatch");
					return;
				}
				const codes = url.searchParams.getAll("code");
				const errors = url.searchParams.getAll("error");
				if (codes.length > 1 || errors.length > 1 || (codes.length > 0 && errors.length > 0)) {
					response.writeHead(400, securityHeaders("text/plain; charset=utf-8")).end("invalid callback parameters");
					return;
				}
				if (errors.length === 1) {
					const descriptions = url.searchParams.getAll("error_description");
					const detail = descriptions.length === 1 ? descriptions[0] : errors[0];
					response.writeHead(200, securityHeaders("text/html; charset=utf-8")).end(safeFailurePage(detail));
					settle(new Error(`authorization failed: ${String(errors[0]).slice(0, 128)}`));
					return;
				}
				const code = codes[0];
				if (code === undefined || code.length === 0 || code.length > MAX_CODE_LENGTH) {
					response.writeHead(400, securityHeaders("text/plain; charset=utf-8")).end(code === undefined ? "missing authorization code" : "authorization code too long");
					return;
				}
				response.writeHead(200, securityHeaders("text/html; charset=utf-8")).end(SUCCESS_PAGE);
				settle(undefined, code);
			};

			bound = await listen(handler, spec.listen);
			if (reservation.cancelled) {
				closeServers(bound.servers);
				throw new Error("login cancelled");
			}
			servers = bound.servers;
			input.redirectUri = `http://${spec.listen.host}:${bound.port}${spec.callbackPath}`;
			const authorizeUrl = spec.buildAuthorizeUrl(input);
			const attempt = {
				authorizeUrl,
				redirectUri: input.redirectUri,
				pkce: input.pkce,
				state: input.state,
				signal: controller.signal,
				waitCode: () => codePromise,
				manual(rawInput) {
					if (settled) throw new Error(`the ${provider} login attempt already finished`);
					if (typeof rawInput !== "string" || rawInput.length > MAX_CODE_LENGTH) throw new Error("authorization input is too long");
					const trimmed = rawInput.trim();
					let code;
					let pastedState;
					if (/^https?:\/\//i.test(trimmed)) {
						const url = new URL(trimmed);
						const codes = url.searchParams.getAll("code");
						const states = url.searchParams.getAll("state");
						if (codes.length !== 1 || states.length > 1) throw new Error("the pasted callback URL has duplicate or missing parameters");
						code = codes[0];
						pastedState = states[0];
					} else if (trimmed.includes("code=")) {
						const params = new URLSearchParams(trimmed.replace(/^\?/, ""));
						const codes = params.getAll("code");
						const states = params.getAll("state");
						if (codes.length !== 1 || states.length > 1) throw new Error("the pasted callback parameters have duplicates or no code");
						code = codes[0];
						pastedState = states[0];
					} else if (trimmed.length > 0 && !/\s/.test(trimmed)) code = trimmed;
					if (code === undefined || code.length === 0 || code.length > MAX_CODE_LENGTH) throw new Error("no usable authorization code found in the pasted input");
					if (pastedState !== undefined && !secureEquals(pastedState, input.state)) throw new Error("state mismatch: the pasted URL belongs to a different login attempt");
					settle(undefined, code);
				},
				cancel() {
					const error = new Error("login cancelled");
					if (settled) {
						controller.abort(error);
						close();
					} else settle(error);
				},
				finish() {
					if (finished) return;
					finished = true;
					close();
					if (thisManager.attempts.get(provider) === attempt) thisManager.attempts.delete(provider);
				}
			};
			const thisManager = this;
			timer = setTimeout(() => settle(new Error(`login timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
			timer.unref();
			this.attempts.set(provider, attempt);
			return attempt;
		} catch (error) {
			if (bound !== undefined) closeServers(bound.servers);
			throw error;
		} finally {
			if (this.starting.get(provider) === reservation) this.starting.delete(provider);
			resolveStarting();
		}
	}

	async cancel(provider) {
		const starting = this.starting.get(provider);
		if (starting !== undefined) starting.cancelled = true;
		const attempt = this.attempts.get(provider);
		attempt?.cancel();
		await Promise.all([starting?.done, attempt?.completion?.catch(() => undefined)].filter(Boolean));
	}

	async stop() {
		for (const starting of this.starting.values()) starting.cancelled = true;
		for (const attempt of this.attempts.values()) attempt.cancel();
		await Promise.all([
			...[...this.starting.values()].map((reservation) => reservation.done),
			...[...this.attempts.values()].map((attempt) => attempt.completion?.catch(() => undefined))
		].filter(Boolean));
	}
}
