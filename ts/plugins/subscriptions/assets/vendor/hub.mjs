// Adapted from dsh-plugin-suite, MIT, copyright 2026 xuediner-source and contributors.
// Source commit 3e70973ecd390d93e5b092e14f09026c1bef9df2. See LICENSE-MIT.txt.
import { LlmAdapter, LlmError, ToolCallId, ReasoningEffortId, attributionHeaders, errorChain, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, QUOTA_EXCEEDED_CODE, dshHomePath } from "../compat.mjs";
import { parseFrames } from "../protocols.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { startQwenDeviceFlow as _startQwenDeviceFlow, qwenPollDeviceToken as _qwenPollDeviceToken, QWEN_MIN_POLL_INTERVAL_MS } from "./auth/qwen-device-flow.mjs";
import { createPkce, OAuthFlowManager } from "./auth/oauth-flow.mjs";
import { assertSessionShape as validateSessionShape, safeDiagnostic, writePrivateJson, readPrivateJson } from "./auth/safety.mjs";

/**
 * Manages in-flight RFC 8628 device-authorization flows (used by Qwen).
 * One flow per provider at a time; tracks verification info and supports
 * cancellation via AbortController.
 */
class DeviceFlowManager {
	flows = /* @__PURE__ */ new Map();
	isBusy(provider) {
		return this.flows.has(provider);
	}
	pending(provider) {
		return this.flows.get(provider);
	}
	/** Alias for pending() — callers may use either name. */
	get(provider) {
		return this.pending(provider);
	}
	reserve(provider, abortController) {
		if (this.flows.has(provider)) return undefined;
		const reservation = { starting: true, abortController };
		this.flows.set(provider, reservation);
		return reservation;
	}
	set(provider, reservation, flow) {
		if (this.flows.get(provider) !== reservation || reservation.abortController.signal.aborted) return false;
		this.flows.set(provider, flow);
		return true;
	}
	delete(provider, expected) {
		if (expected !== undefined && this.flows.get(provider) !== expected) return false;
		return this.flows.delete(provider);
	}
	async cancel(provider) {
		const flow = this.flows.get(provider);
		if (flow === undefined) return;
		flow.abortController?.abort(new Error("login cancelled"));
		this.delete(provider, flow);
		await flow.completion?.catch(() => undefined);
	}
	async stop() {
		await Promise.all([...this.flows.keys()].map((provider) => this.cancel(provider)));
	}
}

//#endregion
//#region src/auth/claude-code-creds.ts
const PRIMARY_SERVICE = "Claude Code-credentials";
const DEFAULT_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";
function toSession(data) {
	if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string" || typeof data.expiresAt !== "number") return;
	const scopes = Array.isArray(data.scopes) ? data.scopes.join(" ") : typeof data.scopes === "string" ? data.scopes : DEFAULT_SCOPES;
	return {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken,
		expiresAt: Math.trunc(data.expiresAt),
		scopes,
		...typeof data.emailAddress === "string" ? { emailAddress: data.emailAddress } : {},
		...typeof data.subscriptionType === "string" ? { subscriptionType: data.subscriptionType } : {}
	};
}
function parseBlob(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	return toSession(parsed.claudeAiOauth ?? parsed);
}
function credentialsFilePath() {
	return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
}
function readKeychainRaw() {
	try {
		return execFileSync("/usr/bin/security", [
			"find-generic-password",
			"-s",
			PRIMARY_SERVICE,
			"-w"
		], {
			timeout: 3e3,
			encoding: "utf8",
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
	} catch {
		return;
	}
}
function readFileRaw() {
	try {
		return readFileSync(credentialsFilePath(), "utf8");
	} catch {
		return;
	}
}
/** Read the current Claude Code session from its source of truth: macOS Keychain, falling back to the credentials file. */
function readClaudeCodeCredentials() {
	if (process.platform === "darwin") {
		const raw$1 = readKeychainRaw();
		const session = raw$1 !== void 0 ? parseBlob(raw$1) : void 0;
		if (session) return session;
	}
	const raw = readFileRaw();
	return raw !== void 0 ? parseBlob(raw) : void 0;
}
// Other clients' credential stores are read-only.

//#region src/auth/store.ts
/** Every provider route, in display order. */
const PROVIDER_IDS = [
	"codex",
	"claude",
	"grok",
	"copilot",
	"antigravity",
	"openrouter",
	"agnes",
	"qwen",
	"spark",
	"ernie"
];
/**
* Absolute path of the auth store file.
* @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
*/
function authFilePath() {
	return dshHomePath("auth.json");
}
/** Store location used before the plugin was renamed; migrated on first read. */
function legacyAuthFilePath() {
	return dshHomePath("unused-legacy-auth.json");
}
/** Check that one durable entry carries the fields every session needs. */
function assertSessionShape(provider, value) {
	validateSessionShape(provider, value);
}
/**
* Read the whole store. A missing file is an empty store; malformed JSON or a
* malformed entry throws, because silently discarding tokens would strand the
* user without a diagnosis.
* @param path - store file path; defaults to {@link authFilePath}.
* @returns the parsed session map.
*/
async function loadStore(path = authFilePath()) {
  const value = await readPrivateJson(path);
  return parseStore(JSON.stringify(value), path);
}
/** Parse and validate store JSON read from `path`. */
function parseStore(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`subscriptions auth store at ${path} is not valid JSON; fix or delete the file`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`);
	const store = parsed;
	for (const provider of PROVIDER_IDS) {
		const entry = store[provider];
		if (entry !== void 0) assertSessionShape(provider, entry);
	}
	return store;
}
/** Persist the whole store atomically with owner-only permissions. */
async function writeStore(store, path) {
	await writePrivateJson(path, store);
}
/**
* Read one provider's session.
* @param provider - the provider route.
* @param path - store file path; defaults to {@link authFilePath}.
* @returns the stored session, or `undefined` when logged out.
*/
async function getSession(provider, path = authFilePath()) {
	return (await loadStore(path))[provider];
}
/**
* Write one provider's session, preserving the others.
* @param provider - the provider route.
* @param session - the fresh session from a login or refresh.
* @param path - store file path; defaults to {@link authFilePath}.
*/

async function saveSessionUnqueued(provider, session, path = authFilePath(), signal) {
	signal?.throwIfAborted();
	const store = await loadStore(path);
	signal?.throwIfAborted();
	store[provider] = session;
	await writePrivateJson(path, store, signal);
}
/**
* Delete one provider's session (logout).
* @param provider - the provider route.
* @param path - store file path; defaults to {@link authFilePath}.
*/
async function deleteSessionUnqueued(provider, path = authFilePath()) {
	const store = await loadStore(path);
	if (store[provider] === void 0) return;
	delete store[provider];
	await writeStore(store, path);
}

//#endregion

//#region src/providers/common.ts
/**
* Validate a configured model catalog (mirrors llm-deepseek's resolveModels).
* @param models - raw configured entries.
* @param label - diagnostic prefix naming the provider.
* @returns the validated entries.
*/
function validateModels(models, label) {
	const seen = /* @__PURE__ */ new Set();
	return models.map((model) => {
		if (model.id.length === 0) throw new Error(`${label}: catalog model ids must be non-empty`);
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`${label}: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`${label}: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`${label}: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (model.apiId !== void 0 && (typeof model.apiId !== "string" || model.apiId.length === 0)) throw new Error(`${label}: catalog model "${model.id}" apiId must be a non-empty string`);
		if (model.inputModalities !== void 0 && (model.inputModalities.length === 0 || model.inputModalities.some((modality) => modality !== "text" && modality !== "image"))) throw new Error(`${label}: catalog model "${model.id}" inputModalities must be a non-empty list of "text"/"image"`);
		if (seen.has(model.id)) throw new Error(`${label}: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...model.apiId === void 0 ? {} : { apiId: model.apiId },
			...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] }
		};
	});
}
/**
* Build an LlmError from a non-2xx provider response, reading and truncating
* the body for the message and mapping the status to a stable code.
* @param response - the failed response.
* @param label - diagnostic prefix naming the provider API.
* @returns the classified error.
*/
async function httpLlmError(response, label) {
	let body = "";
	try {
		body = (await response.text()).slice(0, 500);
	} catch {}
	const locationBlocked = /user location is not supported for the api use|not currently available in your location|unsupported_location/i.test(body);
	const message = locationBlocked
		? `${label}: Google does not support Antigravity API use from this network location. Use a supported-region network exit and try again.`
		: body.length > 0 ? `${label} error (HTTP ${String(response.status)}): ${body}` : `${label} error (HTTP ${String(response.status)})`;
	let code;
	if (locationBlocked) code = "UNSUPPORTED_REGION";
	else if (response.status === 401 || response.status === 403) code = "AUTH";
	else if (isQuotaExceededError(body)) code = QUOTA_EXCEEDED_CODE;
	else if (response.status === 429) code = "RATE_LIMIT";
	else if (response.status === 400 && isContextWindowExceededError(body)) code = CONTEXT_WINDOW_EXCEEDED_CODE;
	else if (response.status === 408 || response.status === 504) code = "TIMEOUT";
	else if (response.status >= 500) code = "SERVER";
	else code = `HTTP_${String(response.status)}`;
	const retryAfter = response.headers.get("retry-after");
	let providerRetryAfterMs;
	if (retryAfter !== null) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) providerRetryAfterMs = seconds * 1e3;
	}
	return new LlmError(message, code, {
		status: response.status,
		...providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs }
	});
}
/**
* Create an idle watchdog chained to the caller's signal.
* @param caller - the request's own abort signal, when present.
* @param timeoutMs - maximum idle interval while a stream read is outstanding.
* @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
*/
function idleWatchdog(caller, timeoutMs) {
	const controller = new AbortController();
	let expired = false;
	let timer;
	const arm = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = setTimeout(() => {
			expired = true;
			controller.abort(/* @__PURE__ */ new Error(`stream idle timeout after ${String(timeoutMs)}ms`));
		}, timeoutMs);
		timer.unref();
	};
	const onCallerAbort = () => controller.abort(caller?.reason);
	if (caller?.aborted === true) controller.abort(caller.reason);
	else caller?.addEventListener("abort", onCallerAbort, { once: true });
	arm();
	return {
		signal: controller.signal,
		pulse: arm,
		stop() {
			if (timer !== void 0) clearTimeout(timer);
			caller?.removeEventListener("abort", onCallerAbort);
		},
		timedOut: () => expired
	};
}
/**
* Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
* expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
* TRANSPORT with the cause chained.
* @param label - diagnostic prefix naming the provider API.
* @param error - the thrown value.
* @param watchdog - the request's idle watchdog.
* @param caller - the request's own abort signal, when present.
* @returns the classified error.
*/
function causeText(error) {
	if (error instanceof Error) {
		const extra = error.cause instanceof Error ? `: ${error.cause.message}` : "";
		return `${error.message}${extra}`;
	}
	return String(error);
}
function isDeadProxyError(error) {
	const text = causeText(error);
	return /ECONNREFUSED[^\n]*7890|connect ECONNREFUSED 127\.0\.0\.1:7890|ECONNREFUSED 127\.0\.0\.1:1080|other side closed|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|socket hang up|ECONNRESET|EPIPE|ETIMEDOUT/i.test(text);
}
/** Gemini 3 requires a thought_signature on every replayed functionCall; this dummy is accepted when the original was stripped. */
const ANTIGRAVITY_DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
/** sessionId:callId → signature captured from the last model turn. */
const antigravityThoughtSignatures = /* @__PURE__ */ new Map();
function antigravitySignatureKey(sessionId, callId) {
	if (typeof callId !== "string" || callId.length === 0) return;
	return `${sessionId ?? ""}:${callId}`;
}
function rememberAntigravityThoughtSignature(sessionId, callId, signature) {
	const key = antigravitySignatureKey(sessionId, callId);
	if (key === void 0 || typeof signature !== "string" || signature.length === 0) return;
	antigravityThoughtSignatures.set(key, signature);
}
async function fetchDirect() { throw new LlmError("Network request failed", "NETWORK"); }
async function fetchProxyThenDirect(url, init) {
	try {
		return await fetch(url, init);
	} catch (error) {
		if (!isDeadProxyError(error)) throw error;
		return await fetchDirect(url, init);
	}
}
function mapFetchFailure(label, error, watchdog, caller) {
	if (watchdog.timedOut()) return new LlmError(`${label} stream idle timeout`, "TIMEOUT", { cause: error });
	if (caller?.aborted === true) return new LlmError(`${label} request aborted by caller`, "ABORTED", { cause: error });
	if (error instanceof LlmError) return error;
	return new LlmError(`${label} request failed: ${causeText(error)}`, "TRANSPORT", { cause: error });
}
/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
var OAuthEndpointError = class extends Error {
	/** HTTP status of the token endpoint response. */
	status;
	/** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
	oauthCode;
	constructor(message, status, oauthCode) {
		super(message);
		this.name = "OAuthEndpointError";
		this.status = status;
		this.oauthCode = oauthCode;
	}
};
/**
* Read an OAuth JSON error body into an {@link OAuthEndpointError}.
* @param response - the failed token-endpoint response.
* @param label - diagnostic prefix naming the provider.
* @returns the error to throw.
*/
async function oauthEndpointError(response, label) {
	let oauthCode;
	try {
		const parsed = await response.json();
		const candidate = typeof parsed.error === "string" ? parsed.error : void 0;
		oauthCode = candidate !== void 0 && /^[A-Za-z0-9._-]{1,128}$/.test(candidate) ? candidate : void 0;
	} catch {}
	const suffix = oauthCode === void 0 ? "" : ` (${oauthCode})`;
	return new OAuthEndpointError(`${label} token endpoint error (HTTP ${String(response.status)})${suffix}`, response.status, oauthCode);
}
/**
* Per-provider session freshness: loads the stored session, refreshes
* proactively inside the preempt window or on demand after a 401, and
* coalesces concurrent refreshes behind one in-flight promise. Permanent
* refresh failures delete the stored session and surface INVALID_CREDENTIAL
* with a re-login hint; transient failures fall back to a still-valid token.
*/
var TokenManager = class {
	inflight;
	constructor(options) {
		this.options = options;
		this.options = options;
	}
	/**
	* Read the stored session without any refresh side effect. Catalog queries
	* (`listModels`) use this to decide whether the provider is logged in.
	* @returns the stored session, or `undefined` when logged out.
	*/
	peek() {
		return this.options.load();
	}
	/**
	* Whether a session is currently stored (cheap; never refreshes).
	* @returns true when logged in.
	*/
	async hasSession() {
		return await this.options.load() !== void 0;
	}
	/**
	* Resolve a usable session, refreshing proactively or on demand.
	* @param forceRefresh - refresh regardless of expiry (used after a 401).
	* @returns the persisted session to send.
	* @throws LlmError MISSING_CREDENTIAL when logged out, INVALID_CREDENTIAL
	*   when the refresh grant is permanently rejected.
	*/
	async session(forceRefresh = false) {
		const session = await this.options.load();
		if (session === void 0) throw new LlmError(`Xueness subscriptions: not logged in to ${this.options.displayName}; log in via Settings â†’ Subscriptions in Xueness`, "MISSING_CREDENTIAL");
		if (!forceRefresh && (typeof session.expiresAt !== "number" || session.expiresAt - Date.now() > this.options.preemptMs)) return session;
		this.inflight ??= this.doRefresh(session).finally(() => {
			this.inflight = void 0;
		});
		try {
			return await this.inflight;
		} catch (error) {
			if (this.options.isPermanent(error)) {
				await this.options.remove();
				this.options.onRemoved?.();
				throw new LlmError(`${this.options.displayName} login expired or was revoked; log in again via Settings â†’ Subscriptions`, "INVALID_CREDENTIAL", { cause: error });
			}
			if (!forceRefresh && session.expiresAt > Date.now()) return session;
			throw error instanceof LlmError ? error : new LlmError(`${this.options.displayName} token refresh failed`, "AUTH", { cause: error });
		}
	}
	async doRefresh(session) {
		const current = await this.options.load();
		if (current !== void 0 && current.accessToken !== session.accessToken && current.expiresAt - Date.now() > this.options.preemptMs) return current;
		const next = await this.options.refresh(current ?? session);
		await this.options.save(next);
		return next;
	}
	/** Drop a session the resource server rejected after a forced refresh. */
	async invalidate() {
		this.inflight = void 0;
		await this.options.remove();
		this.options.onRemoved?.();
	}
};
/** How long a discovered catalog is trusted before re-fetching. */
const DISCOVERY_TTL_MS = 5 * 6e4;
/**
* Cache for one provider's discovered model catalog. The TTL only decides
* when to REFRESH; it never makes the cache forget: capability metadata
* (reasoning efforts) must stay stable for a session that selected an effort,
* or mid-conversation calls fail UNSUPPORTED_REASONING_EFFORT the moment the
* cache goes stale. `listModels` awaits freshness via {@link get};
* `resolveModel` uses {@link resolve}, which serves the last-known catalog
* while a stale entry refreshes in the background, and only awaits the fetch
* when nothing is known yet. An optional {@link CatalogPersistence} seeds the
* last-known state across restarts and receives every successful fetch. A 401
* during a fetch must call {@link invalidate}.
*/
var ModelCatalogCache = class {
	entry;
	inflight;
	/** Settles once the persisted snapshot (when any) has been considered. */
	seeded;
	/** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
	seedDisabled = false;
	constructor(persistence, ttlMs = DISCOVERY_TTL_MS) {
		this.persistence = persistence;
		this.ttlMs = ttlMs;
	}
	/**
	* The cached catalog when fresh, without fetching.
	* @returns the cached models, or `undefined` when absent or stale.
	*/
	cached() {
		if (this.entry === void 0 || Date.now() - this.entry.at >= this.ttlMs) return void 0;
		return this.entry.models;
	}
	/** Load the persisted snapshot once; a fetch or invalidate that landed first wins. */
	ensureSeeded() {
		if (this.persistence === void 0) return Promise.resolve();
		this.seeded ??= this.persistence.load().then((snapshot) => {
			if (snapshot !== void 0 && this.entry === void 0 && !this.seedDisabled) this.entry = snapshot;
		}, () => void 0);
		return this.seeded;
	}
	/** Run (or join) the single in-flight fetch, updating memory and disk on success. */
	refresh(fetcher) {
		this.inflight ??= fetcher().then((models) => {
			const snapshot = {
				at: Date.now(),
				models
			};
			this.entry = snapshot;
			this.persistence?.save(snapshot).catch(() => void 0);
			return models;
		}).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/**
	* Return the cached catalog when fresh, otherwise fetch and cache it.
	* @param fetcher - performs the provider's model-list request.
	* @returns the discovered models.
	* @throws the fetcher's failure (the `listModels` caller warns and falls back).
	*/
	async get(fetcher) {
		await this.ensureSeeded();
		return this.cached() ?? this.refresh(fetcher);
	}
	/**
	* The models for capability resolution. A fresh cache answers directly; a
	* stale one answers immediately from the last-known catalog while a
	* background refresh runs (a mid-conversation `resolveModel` must neither
	* block on nor fail with the network); a cold cache awaits one fetch.
	* @param fetcher - performs the provider's model-list request.
	* @returns the models, or `undefined` when nothing is known (the caller
	*   falls back to its static metadata). Never throws.
	*/
	async resolve(fetcher) {
		await this.ensureSeeded();
		const fresh = this.cached();
		if (fresh !== void 0) return fresh;
		const known = this.entry?.models;
		if (known !== void 0) {
			this.refresh(fetcher).catch(() => void 0);
			return known;
		}
		try {
			return await this.refresh(fetcher);
		} catch {
			return;
		}
	}
	/** Drop the cached catalog (e.g. after a 401 proved the credential changed). */
	invalidate() {
		this.entry = void 0;
		this.seedDisabled = true;
		this.persistence?.clear().catch(() => void 0);
	}
};

//#endregion
//#region src/providers/catalog-store.ts
/**
* Absolute path of the catalog store file.
* @returns `dshHomePath('plugins', 'subscriptions', 'models.json')`.
*/
function modelsFilePath() {
	return dshHomePath("models.json");
}
/** Validate one persisted reasoning block, or undefined when malformed. */
function sanitizeReasoning(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (!Array.isArray(raw.efforts) || raw.efforts.length === 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const efforts = [];
	for (const entry of raw.efforts) {
		if (typeof entry !== "object" || entry === null) return void 0;
		const effort = entry;
		if (typeof effort.id !== "string" || effort.id.length === 0 || typeof effort.name !== "string" || effort.name.length === 0 || effort.description !== void 0 && typeof effort.description !== "string" || seen.has(effort.id)) return void 0;
		seen.add(effort.id);
		efforts.push({
			id: ReasoningEffortId(effort.id),
			name: effort.name,
			...effort.description === void 0 ? {} : { description: effort.description }
		});
	}
	if (raw.defaultEffort !== void 0 && (typeof raw.defaultEffort !== "string" || !seen.has(raw.defaultEffort))) return void 0;
	return {
		efforts,
		...raw.defaultEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(raw.defaultEffort) }
	};
}
/** Validate one persisted model, or undefined when malformed. */
function sanitizeModel(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (typeof raw.id !== "string" || raw.id.length === 0 || typeof raw.name !== "string" || raw.name.length === 0 || raw.description !== void 0 && typeof raw.description !== "string" || raw.contextWindow !== void 0 && (typeof raw.contextWindow !== "number" || !Number.isInteger(raw.contextWindow) || raw.contextWindow <= 0) || raw.priority !== void 0 && (typeof raw.priority !== "number" || !Number.isFinite(raw.priority))) return void 0;
	if (raw.apiId !== void 0 && (typeof raw.apiId !== "string" || raw.apiId.length === 0)) return void 0;
	if (raw.maxTokens !== void 0 && (typeof raw.maxTokens !== "number" || !Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0)) return void 0;
	if (raw.inputModalities !== void 0 && (!Array.isArray(raw.inputModalities) || raw.inputModalities.length === 0 || raw.inputModalities.some((modality) => modality !== "text" && modality !== "image"))) return void 0;
	const reasoning = raw.reasoning === void 0 ? void 0 : sanitizeReasoning(raw.reasoning);
	if (raw.reasoning !== void 0 && reasoning === void 0) return void 0;
	const thinkingType = raw.thinkingType;
	if (thinkingType !== void 0 && thinkingType !== "enabled" && thinkingType !== "adaptive") return void 0;
	const fastTier = raw.fastTier;
	if (fastTier !== void 0 && typeof fastTier !== "boolean") return void 0;
	return {
		id: raw.id,
		name: raw.name,
		...raw.description === void 0 ? {} : { description: raw.description },
		...raw.contextWindow === void 0 ? {} : { contextWindow: raw.contextWindow },
		...raw.priority === void 0 ? {} : { priority: raw.priority },
		...raw.apiId === void 0 ? {} : { apiId: raw.apiId },
		...raw.maxTokens === void 0 ? {} : { maxTokens: raw.maxTokens },
		...raw.inputModalities === void 0 ? {} : { inputModalities: [...raw.inputModalities] },
		...reasoning === void 0 ? {} : { reasoning },
		...thinkingType === void 0 ? {} : { thinkingType },
		...fastTier === void 0 ? {} : { fastTier }
	};
}
/**
* Validate one persisted snapshot. Strict: any malformed field drops the
* whole snapshot rather than repairing it â€” the next successful discovery
* rewrites the entry anyway.
* @param value - the raw per-provider file entry.
* @returns the validated snapshot, or undefined when unusable.
*/
function sanitizeSnapshot(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return void 0;
	if (!Array.isArray(raw.models) || raw.models.length === 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const entry of raw.models) {
		const model = sanitizeModel(entry);
		if (model === void 0 || seen.has(model.id)) return void 0;
		seen.add(model.id);
		models.push(model);
	}
	return {
		at: raw.at,
		models
	};
}
/** Read the whole file; missing or unparsable reads as an empty cache. */
async function readCatalogFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/** Persist the whole file atomically (tmp file + rename). */
async function writeCatalogFile(store, path) {
	await mkdir(dirname(path), { recursive: true, mode: 448 });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(store, null, 2));
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* Build the durable half of one provider's catalog cache over the shared
* models.json file (concurrent writers are last-writer-wins, acceptable for
* a cache).
* @param provider - the provider route keying the file entry.
* @param path - store file path; defaults to {@link modelsFilePath}.
* @returns the persistence hooks for {@link ModelCatalogCache}.
*/
function catalogStore(provider, path = modelsFilePath()) {
	return {
		async load() {
			return sanitizeSnapshot((await readCatalogFile(path))[provider]);
		},
		async save(snapshot) {
			const store = await readCatalogFile(path);
			store[provider] = snapshot;
			await writeCatalogFile(store, path);
		},
		async clear() {
			const store = await readCatalogFile(path);
			if (store[provider] === void 0) return;
			delete store[provider];
			await writeCatalogFile(store, path);
		}
	};
}

//#endregion
//#region src/auth/jwt.ts
/** Minimal JWT payload decoding for claims extraction (no signature verification). */
/**
* Decode a JWT payload without verifying the signature. Used only to read
* account claims from `id_token`s issued over the provider's own TLS channel
* during a code exchange we initiated â€” never to authorize anything.
* @param token - the compact JWT string.
* @returns the parsed payload object, or `undefined` when the token is not a
*   well-formed JWT with a JSON object payload.
*/
function decodeJwtPayload(token) {
	const parts = token.split(".");
	if (parts.length < 2) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	return parsed;
}

//#endregion
//#region src/translate/resolved.ts
/**
* Resolve every ImageBlock's attachment reference to inline base64 bytes.
* Messages without images pass through unchanged. A request carrying an image
* with no attachment service available fails loudly rather than silently
* dropping the image.
* @param messages - the request's conversation messages.
* @param attachments - the deployment's attachment service, when mounted.
* @param signal - cancellation for the storage reads.
* @returns the same messages with image blocks resolved for the translators.
*/
async function resolveImages(messages, attachments, signal) {
	if (!messages.some((message) => message.content.some((block) => block.type === "image"))) return messages;
	if (messages.every(message => message.content.every(block => block.type !== "image" || "dataBase64" in block))) return messages;
	if (attachments === void 0) throw new LlmError("Xueness subscriptions: the request carries an image but no attachments service is mounted; image input requires the harness attachment store", "UNSUPPORTED");
	return Promise.all(messages.map(async (message) => ({
		role: message.role,
		content: await Promise.all(message.content.map(async (block) => {
			if (block.type !== "image") return block;
			const stored = await attachments.readImage(block.attachment, signal);
			return {
				type: "image",
				mediaType: stored.ref.mediaType,
				dataBase64: Buffer.from(stored.data).toString("base64")
			};
		}))
	})));
}

//#endregion
//#region src/translate/sse.ts
/**
* Decode an SSE byte stream into events.
* @param stream - raw response bytes; reads may split anywhere, including mid-UTF-8 sequence.
* @param onActivity - called on every received chunk and comment line; drives the idle watchdog.
* @returns events in arrival order.
*/
async function* parseSse(stream, onActivity) {
  for await (const frame of parseFrames(stream, { onActivity })) {
    if (frame.data !== "[DONE]") yield frame;
  }
}

//#endregion
//#region src/translate/responses.ts
/** Flatten a tool result's content to plain text for `function_call_output`. */
function toolResultText$1(block) {
	return block.content.map((part) => part.type === "text" ? part.text : "").join("");
}
/**
* Convert harness messages into Responses `instructions` + `input` items.
* System-role messages become `instructions`; an explicit `system` argument
* wins over them when both exist. Reasoning blocks are not replayed (v1).
* Images must arrive pre-resolved ({@link TranslatableMessage}); an unresolved
* ImageBlock is skipped because its bytes are unreachable here.
* @param messages - ordered conversation messages with resolved images.
* @param system - explicit system prompt, which takes precedence.
* @returns request fields ready to merge into the request body.
*/
/** Codex rejects function_call.call_id longer than 64 characters. */
function codexCallId(id) {
	const raw = String(id ?? "");
	if (raw.length > 0 && raw.length <= 64) return raw;
	return createHash("sha256").update(raw).digest("hex").slice(0, 64);
}
function toResponsesInput(messages, system) {
	const input = [];
	const systemTexts = [];
	for (const message of messages) {
		if (message.role === "system") {
			for (const block of message.content) if (block.type === "text") systemTexts.push(block.text);
			continue;
		}
		const role = message.role;
		let content = [];
		const flushMessage = () => {
			if (content.length === 0) return;
			input.push({
				type: "message",
				role,
				content
			});
			content = [];
		};
		for (const block of message.content) switch (block.type) {
			case "text":
				content.push({
					type: role === "assistant" ? "output_text" : "input_text",
					text: block.text
				});
				break;
			case "tool-call":
				flushMessage();
				input.push({
					type: "function_call",
					call_id: codexCallId(block.id),
					name: block.name,
					arguments: block.arguments
				});
				break;
			case "tool-result":
				flushMessage();
				input.push({
					type: "function_call_output",
					call_id: codexCallId(block.toolCallId),
					output: toolResultText$1(block)
				});
				break;
			case "image":
				if ("dataBase64" in block) content.push({
					type: "input_image",
					image_url: `data:${block.mediaType};base64,${block.dataBase64}`
				});
				break;
			default: break;
		}
		flushMessage();
	}
	const instructions = system ?? (systemTexts.length > 0 ? systemTexts.join("\n\n") : void 0);
	return {
		...instructions === void 0 ? {} : { instructions },
		input: pairResponsesToolCalls(input)
	};
}
/** Codex rejects a function_call with no matching function_call_output. Interrupted
 *  subagents and compacted history can leave orphans; synthesize a short result. */
function pairResponsesToolCalls(input) {
	const outputById = new Map();
	for (const item of input) {
		if (item?.type === "function_call_output" && typeof item.call_id === "string" && item.call_id.length > 0 && !outputById.has(item.call_id)) outputById.set(item.call_id, item);
	}
	const paired = [];
	const usedOutputs = new Set();
	for (const item of input) {
		if (item?.type === "function_call" && typeof item.call_id === "string" && item.call_id.length > 0) {
			paired.push(item);
			if (!usedOutputs.has(item.call_id)) {
				paired.push(outputById.get(item.call_id) ?? { type: "function_call_output", call_id: item.call_id, output: "[tool interrupted before a result was returned]" });
				usedOutputs.add(item.call_id);
			}
			continue;
		}
		if (item?.type === "function_call_output") continue;
		paired.push(item);
	}
	return paired;
}
/**
* Map harness tool schemas to Responses function tools.
* @param tools - tool schemas from the request.
* @returns Responses `tools` array entries.
*/
function toResponsesTools(tools) {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
}
/** Grok rejects oversized Responses payloads with HTTP 413. Keep the
 * newest human turns, preserve function-call/output pairs, and bound large
 * tool results before retrying instead of failing the whole agent turn. */
const GROK_BODY_SOFT_LIMIT = 900_000;
const GROK_BODY_HARD_LIMIT = 1_200_000;
const GROK_RETRY_BODY_LIMIT = 400_000;
const GROK_INPUT_BUDGET = 650_000;
const GROK_AGGRESSIVE_INPUT_BUDGET = 300_000;
const GROK_FINAL_INPUT_BUDGET = 180_000;
const GROK_MINIMAL_INPUT_BUDGET = 96_000;
const GROK_MINIMAL_FINAL_INPUT_BUDGET = 48_000;
const GROK_MAX_TOOL_OUTPUT_CHARS = 16_000;
const GROK_AGGRESSIVE_TOOL_OUTPUT_CHARS = 6_000;
const GROK_MINIMAL_TOOL_OUTPUT_CHARS = 2_000;
const GROK_MAX_ARGUMENT_CHARS = 24_000;
const GROK_AGGRESSIVE_ARGUMENT_CHARS = 8_000;
const GROK_MINIMAL_ARGUMENT_CHARS = 4_000;
const GROK_MAX_MESSAGE_TEXT_CHARS = 64_000;
const GROK_AGGRESSIVE_MESSAGE_TEXT_CHARS = 32_000;
const GROK_MINIMAL_MESSAGE_TEXT_CHARS = 12_000;
const GROK_MAX_INSTRUCTIONS_CHARS = 96_000;
const GROK_AGGRESSIVE_INSTRUCTIONS_CHARS = 48_000;
const GROK_MINIMAL_INSTRUCTIONS_CHARS = 16_000;
const GROK_MAX_IMAGE_CHARS = 320_000;

function utf8Bytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function shortenGrokText(value, maximum, keepTail = false) {
	if (typeof value !== "string" || value.length <= maximum) return value;
	if (maximum <= 0) return "";
	const marker = "\n…[older content omitted to fit Grok request]…\n";
	const room = Math.max(0, maximum - marker.length);
	if (keepTail) {
		const head = Math.min(Math.floor(room * 0.2), 2000);
		return value.slice(0, head) + marker + value.slice(-(room - head));
	}
	const head = Math.floor(room * 0.7);
	return value.slice(0, head) + marker + value.slice(-Math.max(0, room - head));
}
/** Keep a function-call argument syntactically valid when shortening history. */
function compactGrokArguments(value, maximum) {
	if (typeof value !== "string" || value.length <= maximum) return value;
	try {
		const normalized = JSON.stringify(JSON.parse(value));
		if (normalized.length <= maximum) return normalized;
	} catch {}
	return "{\"_dsh_history_truncated\":true}";
}
function compactGrokInputItem(item, level) {
	const aggressive = level === true || level === "aggressive" || level === "minimal";
	const minimal = level === "minimal";
	if (item?.type === "function_call_output") return {
		...item,
		output: shortenGrokText(item.output, minimal ? GROK_MINIMAL_TOOL_OUTPUT_CHARS : aggressive ? GROK_AGGRESSIVE_TOOL_OUTPUT_CHARS : GROK_MAX_TOOL_OUTPUT_CHARS, true)
	};
	if (item?.type === "function_call") return {
		...item,
		arguments: compactGrokArguments(item.arguments, minimal ? GROK_MINIMAL_ARGUMENT_CHARS : aggressive ? GROK_AGGRESSIVE_ARGUMENT_CHARS : GROK_MAX_ARGUMENT_CHARS)
	};
	if (item?.type !== "message" || !Array.isArray(item.content)) return item;
	const maximum = minimal ? GROK_MINIMAL_MESSAGE_TEXT_CHARS : aggressive ? GROK_AGGRESSIVE_MESSAGE_TEXT_CHARS : GROK_MAX_MESSAGE_TEXT_CHARS;
	let textBudget = minimal ? 16_000 : aggressive ? 48_000 : 96_000;
	const content = [];
	for (const part of item.content) {
		if (part?.type === "input_text" || part?.type === "output_text") {
			const limit = Math.min(maximum, textBudget);
			if (limit > 0) content.push({ ...part, text: shortenGrokText(part.text, limit) });
			textBudget -= Math.min(typeof part.text === "string" ? part.text.length : 0, limit);
			continue;
		}
		if (part?.type === "input_image" && typeof part.image_url === "string" && part.image_url.startsWith("data:") && (minimal || aggressive || part.image_url.length > GROK_MAX_IMAGE_CHARS)) {
			content.push({ type: "input_text", text: "[image omitted from Grok history to fit request limit]" });
			continue;
		}
		content.push(part);
	}
	return { ...item, content };
}
function grokUserTurnStarts(input) {
	const starts = [];
	for (let i = 0; i < input.length; i++) if (input[i]?.type === "message" && input[i].role === "user") starts.push(i);
	return starts;
}
function grokSuffixStartWithToolPairs(input, start) {
	let first = start;
	const wanted = new Set(input.slice(start).filter((item) => item?.type === "function_call_output" && typeof item.call_id === "string").map((item) => item.call_id));
	if (wanted.size === 0) return first;
	for (let i = 0; i < start; i++) if (input[i]?.type === "function_call" && wanted.has(input[i].call_id)) first = Math.min(first, i);
	return first;
}
/** Group a function call with its output so suffix trimming never sends an orphan. */
function grokInputUnits(input, start) {
	const outputs = new Map();
	for (let i = start; i < input.length; i++) {
		const item = input[i];
		if (item?.type === "function_call_output" && typeof item.call_id === "string") outputs.set(item.call_id, i);
	}
	const used = new Set();
	const units = [];
	for (let i = start; i < input.length; i++) {
		if (used.has(i)) continue;
		const item = input[i];
		if (item?.type === "function_call" && typeof item.call_id === "string") {
			const output = outputs.get(item.call_id);
			if (output !== void 0) {
				used.add(i);
				used.add(output);
				units.push([i, output]);
				continue;
			}
		}
		used.add(i);
		units.push([i, i]);
	}
	return units;
}
function grokSuffixWithinBytes(input, start, maximumBytes) {
	const units = grokInputUnits(input, start);
	const selected = [];
	let bytes = 2;
	for (let i = units.length - 1; i >= 0; i--) {
		const [from, to] = units[i];
		const unitBytes = utf8Bytes(input.slice(from, to + 1));
		if (selected.length === 0 || bytes + unitBytes <= maximumBytes) {
			for (let index = from; index <= to; index++) selected.push(index);
			bytes += unitBytes;
		}
	}
	selected.sort((a, b) => a - b);
	return selected.map((index) => input[index]);
}
function compactGrokInput(input, maximumBytes, aggressive) {
	if (!Array.isArray(input) || utf8Bytes(input) <= maximumBytes) return input;
	const compacted = input.map((item) => compactGrokInputItem(item, aggressive));
	const starts = grokUserTurnStarts(input);
	const candidates = starts.length > 0 ? [Math.min(4, starts.length), Math.min(2, starts.length), 1] : [0];
	for (const count of candidates) {
		const rawStart = starts.length > 0 ? starts[Math.max(0, starts.length - count)] : Math.max(0, input.length - 24);
		const start = grokSuffixStartWithToolPairs(input, rawStart);
		const candidate = grokSuffixWithinBytes(compacted, start, maximumBytes);
		if (utf8Bytes(candidate) <= maximumBytes) return candidate;
	}
	const rawStart = starts.length > 0 ? starts[starts.length - 1] : Math.max(0, input.length - 8);
	return grokSuffixWithinBytes(compacted, grokSuffixStartWithToolPairs(input, rawStart), maximumBytes);
}
function compactGrokSchema(value, level) {
	const aggressive = level === true || level === "aggressive" || level === "minimal";
	const minimal = level === "minimal";
	if (Array.isArray(value)) return value.map((entry) => compactGrokSchema(entry, level));
	if (value === null || typeof value !== "object") return value;
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "examples" || key === "example" || key === "$comment" || aggressive && key === "default") continue;
		if (key === "description") {
			result[key] = shortenGrokText(entry, minimal ? 120 : aggressive ? 400 : 2000);
			continue;
		}
		if (key === "title") {
			result[key] = shortenGrokText(entry, minimal ? 100 : 200);
			continue;
		}
		result[key] = compactGrokSchema(entry, level);
	}
	return result;
}
function compactGrokTools(tools, level = false) {
	if (!Array.isArray(tools)) return tools;
	const minimal = level === "minimal";
	const aggressive = level === true || level === "aggressive" || minimal;
	return tools.map((tool) => ({
		...tool,
		description: typeof tool?.description === "string" ? shortenGrokText(tool.description, minimal ? 120 : aggressive ? 400 : 4000) : tool?.description,
		parameters: compactGrokSchema(tool?.parameters, level)
	}));
}
function grokAvailableOutputTokens(options, instructions, input, tools) {
	if (typeof options.maxTokens !== "number" || !Number.isFinite(options.maxTokens)) return void 0;
	const estimatedInputTokens = Math.ceil(utf8Bytes({ instructions, input, tools }) / 3);
	const available = GROK_CONTEXT_WINDOW - estimatedInputTokens - 1024;
	if (available <= 0) return 1024;
	return Math.max(1024, Math.min(Math.floor(options.maxTokens), available));
}
function makeGrokBody(options, instructions, input, tools) {
	const maxOutputTokens = grokAvailableOutputTokens(options, instructions, input, tools);
	return {
		model: options.model,
		...instructions === void 0 ? {} : { instructions },
		input,
		...tools !== void 0 && tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {},
		...maxOutputTokens === void 0 ? {} : { max_output_tokens: maxOutputTokens },
		...options.reasoningEffort !== void 0 ? { reasoning: { effort: String(options.reasoningEffort) } } : {},
		store: false,
		stream: true
	};
}
function buildGrokBody(options, messages, compactLevel) {
	let { instructions, input } = toResponsesInput(messages, options.system);
	let tools = options.tools !== void 0 && options.tools.length > 0 ? toResponsesTools(options.tools) : void 0;
	let body = makeGrokBody(options, instructions, input, tools);
	const minimal = compactLevel === "minimal";
	const aggressive = compactLevel === "aggressive" || minimal;
	if (aggressive || utf8Bytes(body) > GROK_BODY_SOFT_LIMIT) {
		instructions = shortenGrokText(instructions, minimal ? GROK_MINIMAL_INSTRUCTIONS_CHARS : aggressive ? GROK_AGGRESSIVE_INSTRUCTIONS_CHARS : GROK_MAX_INSTRUCTIONS_CHARS);
		input = compactGrokInput(input, minimal ? GROK_MINIMAL_INPUT_BUDGET : aggressive ? GROK_AGGRESSIVE_INPUT_BUDGET : GROK_INPUT_BUDGET, minimal ? "minimal" : aggressive);
		tools = compactGrokTools(tools, minimal ? "minimal" : aggressive);
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (utf8Bytes(body) > GROK_BODY_SOFT_LIMIT) {
		instructions = shortenGrokText(instructions, minimal ? 8_000 : GROK_AGGRESSIVE_INSTRUCTIONS_CHARS);
		input = compactGrokInput(input, minimal ? GROK_MINIMAL_FINAL_INPUT_BUDGET : GROK_FINAL_INPUT_BUDGET, "minimal");
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (compactLevel !== void 0 && utf8Bytes(body) > GROK_RETRY_BODY_LIMIT) {
		// A 413 retry must be comfortably below xAI's limit even when the
		// original failure came mostly from tool schemas rather than history.
		instructions = shortenGrokText(instructions, 8_000);
		input = compactGrokInput(input, GROK_MINIMAL_FINAL_INPUT_BUDGET, "minimal");
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (compactLevel !== void 0 && utf8Bytes(body) > GROK_RETRY_BODY_LIMIT) {
		// Tool definitions are optional for this last-resort replay. Dropping
		// them is safer than sending another request that the provider rejects.
		instructions = shortenGrokText(instructions, 4_000);
		input = compactGrokInput(input, 24_000, "minimal");
		tools = void 0;
		body = makeGrokBody(options, instructions, input, tools);
	}
	if (utf8Bytes(body) > GROK_BODY_HARD_LIMIT) {
		instructions = shortenGrokText(instructions, 4_000);
		input = compactGrokInput(input, 24_000, "minimal");
		tools = compactGrokTools(tools, "minimal");
		body = makeGrokBody(options, instructions, input, tools);
	}
	return body;
}
/**
* Map Responses usage to disjoint harness counts (cached input is subtracted
* out of `inputTokens` and reported as `cacheReadTokens`).
* @param usage - wire usage from `response.completed`.
* @returns harness token usage.
*/
function mapResponsesUsage(usage) {
	const cached = usage.input_tokens_details?.cached_tokens;
	const reasoning = usage.output_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.input_tokens - (cached ?? 0),
		outputTokens: usage.output_tokens,
		...cached !== void 0 ? { cacheReadTokens: cached } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/**
* Classify a Responses failure payload into a thrown LlmError.
* @param code - provider error code, when present.
* @param message - provider error message, when present.
* @returns the mapped error (context overflow, quota, otherwise SERVER).
*/
function responsesFailure(code, message) {
	const text = message ?? code ?? "the provider reported a failed response";
	const detail = `${code ?? ""} ${message ?? ""}`;
	if (code === "context_window_exceeded" || isContextWindowExceededError(detail)) return new LlmError(text, CONTEXT_WINDOW_EXCEEDED_CODE);
	if (isQuotaExceededError({ code }) || isQuotaExceededError(detail)) return new LlmError(text, QUOTA_EXCEEDED_CODE);
	return new LlmError(text, "SERVER");
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock$1(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Push-model Responses SSE translator: feed each parsed event object to
* {@link push} and collect the emitted harness StreamChunks. Block indexes
* are allocated in first-seen order; `usage` is emitted before the terminal
* `finish`, and nothing is emitted after it. Terminal provider failures
* throw {@link LlmError}.
*/
var ResponsesStreamTranslator = class {
	blocks = /* @__PURE__ */ new Map();
	order = [];
	nextIndex = 0;
	sawToolCall = false;
	/** Set once `response.completed` produced the terminal finish chunk. */
	terminated = false;
	open(key, kind, chunks, callId = "", name$1) {
		const block = {
			index: this.nextIndex++,
			kind,
			text: "",
			callId,
			...name$1 === void 0 ? {} : { name: name$1 }
		};
		this.blocks.set(key, block);
		this.order.push(block);
		chunks.push({
			type: "block-start",
			index: block.index,
			blockType: kind
		});
		return block;
	}
	textBlock(key, chunks) {
		return this.blocks.get(key) ?? this.open(key, "text", chunks);
	}
	reasoningBlock(key, chunks) {
		return this.blocks.get(key) ?? this.open(key, "reasoning", chunks);
	}
	close(key, chunks) {
		const block = this.blocks.get(key);
		if (block === void 0) return;
		this.blocks.delete(key);
		chunks.push({
			type: "block-end",
			index: block.index,
			block: closeBlock$1(block)
		});
	}
	/** Close every still-open block for one output item (prefix match on the key). */
	closeItem(itemId, chunks) {
		for (const key of [...this.blocks.keys()]) if (key.startsWith(`${itemId}:`)) this.close(key, chunks);
	}
	/** Close every still-open block (provider ended the response without done events). */
	closeAll(chunks) {
		for (const block of this.order) this.closeKeyIfOpen(block, chunks);
	}
	closeKeyIfOpen(block, chunks) {
		for (const [key, candidate] of this.blocks) if (candidate === block) {
			this.blocks.delete(key);
			chunks.push({
				type: "block-end",
				index: block.index,
				block: closeBlock$1(block)
			});
			return;
		}
	}
	/**
	* Process one parsed Responses SSE event.
	* @param event - the parsed event object.
	* @returns the StreamChunks this event produced (possibly none).
	*/
	push(event) {
		if (this.terminated) return [];
		const chunks = [];
		switch (event.type) {
			case "response.output_item.added": {
				const item = event.item;
				if (item?.type === "function_call" && item.id !== void 0) {
					this.sawToolCall = true;
					const callId = item.call_id ?? "";
					const block = this.open(`${item.id}:call`, "tool-call", chunks, callId, item.name);
					chunks.push({
						type: "tool-call-delta",
						index: block.index,
						id: ToolCallId(callId),
						...item.name === void 0 ? {} : { name: item.name },
						argumentsDelta: ""
					});
				}
				return chunks;
			}
			case "response.output_text.delta": {
				const key = `${event.item_id ?? ""}:text:${String(event.content_index ?? 0)}`;
				const block = this.textBlock(key, chunks);
				block.text += event.delta ?? "";
				chunks.push({
					type: "text-delta",
					index: block.index,
					text: event.delta ?? ""
				});
				return chunks;
			}
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta": {
				const sub = event.summary_index ?? event.content_index ?? 0;
				const key = `${event.item_id ?? ""}:reason:${String(sub)}`;
				const block = this.reasoningBlock(key, chunks);
				block.text += event.delta ?? "";
				chunks.push({
					type: "reasoning-delta",
					index: block.index,
					text: event.delta ?? ""
				});
				return chunks;
			}
			case "response.function_call_arguments.delta": {
				const key = `${event.item_id ?? ""}:call`;
				let block = this.blocks.get(key);
				if (block === void 0) {
					this.sawToolCall = true;
					block = this.open(key, "tool-call", chunks);
				}
				block.text += event.delta ?? "";
				chunks.push({
					type: "tool-call-delta",
					index: block.index,
					id: ToolCallId(block.callId),
					...block.name === void 0 ? {} : { name: block.name },
					argumentsDelta: event.delta ?? ""
				});
				return chunks;
			}
			case "response.output_item.done": {
				const item = event.item;
				if (item === void 0 || item.id === void 0) return chunks;
				if (item.type === "function_call") {
					const key = `${item.id}:call`;
					const block = this.blocks.get(key);
					if (block !== void 0 && block.text.length === 0 && item.arguments !== void 0) block.text = item.arguments;
					this.close(key, chunks);
				} else if (item.type === "message") {
					if (![...this.blocks.keys()].some((key) => key.startsWith(`${item.id}:text:`))) for (const [partIndex, part] of (item.content ?? []).entries()) {
						if (part?.type !== "output_text" || typeof part.text !== "string" || part.text.length === 0) continue;
						const block = this.open(`${item.id}:text:${partIndex}`, "text", chunks);
						block.text = part.text;
						this.close(`${item.id}:text:${partIndex}`, chunks);
					}
					this.closeItem(item.id, chunks);
				} else this.closeItem(item.id, chunks);
				return chunks;
			}
			case "response.completed": {
				this.terminated = true;
				this.closeAll(chunks);
				const usage = event.response?.usage;
				if (usage !== void 0) chunks.push({
					type: "usage",
					usage: mapResponsesUsage(usage)
				});
				if (this.order.length === 0) chunks.push({
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: "model returned a completed response with no content",
							code: EMPTY_RESPONSE_CODE
						}
					}
				});
				else chunks.push({
					type: "finish",
					reason: { kind: this.sawToolCall ? "tool-calls" : "stop" }
				});
				return chunks;
			}
			case "response.failed": throw responsesFailure(event.response?.error?.code, event.response?.error?.message);
			case "response.incomplete": throw responsesFailure(event.response?.incomplete_details?.reason, event.response?.error?.message ?? `the provider reported an incomplete response (${event.response?.incomplete_details?.reason ?? "unknown reason"})`);
			case "error": throw responsesFailure(event.code, event.message);
			default: return chunks;
		}
	}
};
/**
* Consume a Responses SSE byte stream and yield harness StreamChunks.
* @param stream - raw response body.
* @param onActivity - transport-activity callback for the idle watchdog.
* @returns the chunk stream; throws when the stream ends before `response.completed`.
*/
async function* streamResponses(stream, onActivity) {
	const translator = new ResponsesStreamTranslator();
	for await (const sseEvent of parseSse(stream, onActivity)) {
		let event;
		try {
			event = JSON.parse(sseEvent.data);
		} catch {
			throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		if (typeof event.response?.model === 'string') yield { type: 'response-model', model: event.response.model };
		yield* translator.push(event);
		if (translator.terminated) return;
	}
	throw new LlmError("Responses SSE stream ended before response.completed", "STREAM_CLOSED");
}

//#endregion
//#region src/providers/codex.ts
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_CALLBACK_PATH = "/auth/callback";
const CODEX_CONTEXT_WINDOW = 4e5;
const CODEX_DEFAULT_MAX_TOKENS = 128e3;
/** Refresh when the access token has less than this much life left. */
const CODEX_PREEMPT_MS = 5 * 6e4;
/** Default instruction when the request carries no system prompt. */
const DEFAULT_CODEX_INSTRUCTIONS = "You are Codex, a coding agent based on GPT-5. Help the user with their software engineering tasks.";
/** Refresh-grant rejections that mean the login is gone for good. */
const PERMANENT_REFRESH_CODES = new Set([
	"refresh_token_expired",
	"refresh_token_reused",
	"refresh_token_invalidated",
	"invalid_grant"
]);
const CODEX_EFFORTS = [
	{
		id: ReasoningEffortId("minimal"),
		name: "Minimal"
	},
	{
		id: ReasoningEffortId("low"),
		name: "Low"
	},
	{
		id: ReasoningEffortId("medium"),
		name: "Medium"
	},
	{
		id: ReasoningEffortId("high"),
		name: "High"
	},
	{
		id: ReasoningEffortId("xhigh"),
		name: "Extra High"
	}
];
const CODEX_DEFAULT_EFFORT = ReasoningEffortId("high");
/** Every gpt-5.x codex model accepts image input. */
const CODEX_MODALITIES = ["text", "image"];
/**
* Fast tier (the codex CLI's "fast mode"): the Responses `service_tier` wire
* value for priority processing, mirroring codex-rs
* `ServiceTier::Fast.request_value()`. The legacy catalog spelling is the
* `additional_speed_tiers` entry "fast".
*/
const CODEX_FAST_SERVICE_TIER = "priority";
const CODEX_FAST_SPEED_TIER = "fast";
/** Static codex flow facts for the OAuth flow engine. */
const codexFlow = {
	callbackPath: CODEX_CALLBACK_PATH,
	listen: {
		host: "localhost",
		ports: [1455, 1457]
	},
	buildAuthorizeUrl({ redirectUri, state, pkce }) {
		return `${CODEX_AUTHORIZE_URL}?${new URLSearchParams({
			response_type: "code",
			client_id: CODEX_CLIENT_ID,
			redirect_uri: redirectUri,
			scope: CODEX_SCOPE,
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
			state,
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: "codex_cli_rs"
		}).toString()}`;
	}
};
/** Pull `chatgpt_account_id` out of an id token payload. */
function accountIdOf(idToken) {
	const auth = (idToken === void 0 ? void 0 : decodeJwtPayload(idToken))?.["https://api.openai.com/auth"];
	const accountId = typeof auth === "object" && auth !== null ? auth.chatgpt_account_id : void 0;
	if (typeof accountId !== "string" || accountId.length === 0) throw new Error("codex login did not return a chatgpt account id; cannot use the subscription");
	return accountId;
}
/**
* Decode the user-identity claims of a codex id token (pure, cheap â€” no
* verification, same trust posture as {@link accountIdOf}). Claim paths
* mirror codex-rs `login/src/token_data.rs`: the email is the top-level
* `email` claim, falling back to `https://api.openai.com/profile`.email; the
* plan is `https://api.openai.com/auth`.chatgpt_plan_type.
* @param idToken - a stored or freshly issued id token, when present.
* @returns whichever claims the token carried; empty when undecodable.
*/
function codexProfileClaims(idToken) {
	const payload = idToken === void 0 ? void 0 : decodeJwtPayload(idToken);
	if (payload === void 0) return {};
	const profile = payload["https://api.openai.com/profile"];
	const profileEmail = typeof profile === "object" && profile !== null ? profile.email : void 0;
	const email = payload.email ?? profileEmail;
	const auth = payload["https://api.openai.com/auth"];
	const plan = typeof auth === "object" && auth !== null ? auth.chatgpt_plan_type : void 0;
	return {
		...typeof email === "string" && email.length > 0 ? { emailAddress: email } : {},
		...typeof plan === "string" && plan.length > 0 ? { planType: plan } : {}
	};
}
/** Build a session from a token response; expires_in wins, JWT exp is the fallback. */
function codexSession(tokens, fallback) {
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new Error("codex token endpoint returned no access token");
	const refreshToken = tokens.refresh_token ?? fallback?.refreshToken;
	if (refreshToken === void 0) throw new Error("codex token endpoint returned no refresh token");
	let expiresAt;
	if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) expiresAt = Date.now() + tokens.expires_in * 1e3;
	else {
		const exp = decodeJwtPayload(tokens.access_token)?.exp;
		if (typeof exp === "number" && exp > 0) expiresAt = exp * 1e3;
	}
	if (expiresAt === void 0) throw new Error("codex token endpoint returned no usable expiry");
	const idToken = tokens.id_token ?? fallback?.idToken;
	const claims = {
		...fallback?.emailAddress === void 0 ? {} : { emailAddress: fallback.emailAddress },
		...fallback?.planType === void 0 ? {} : { planType: fallback.planType },
		...codexProfileClaims(tokens.id_token)
	};
	return {
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt,
		accountId: tokens.id_token === void 0 && fallback !== void 0 ? fallback.accountId : accountIdOf(tokens.id_token),
		...idToken === void 0 ? {} : { idToken },
		...claims
	};
}
/**
* Exchange an authorization code for a codex session (form-encoded grant).
* @param code - the authorization code from the callback.
* @param verifier - the PKCE verifier minted for the attempt.
* @param redirectUri - the attempt's redirect URI.
* @returns the session to store.
*/
async function exchangeCodexCode(code, verifier, redirectUri, signal) {
	const response = await fetch(CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CODEX_CLIENT_ID,
			code_verifier: verifier
		}).toString(), signal
	});
	if (!response.ok) throw await oauthEndpointError(response, "codex");
	return codexSession(await response.json());
}
/**
* Refresh a codex session (JSON grant â€” unlike the code exchange).
* @param session - the stored session.
* @returns the fresh session to store.
*/
async function refreshCodex(session) {
	const response = await fetch(CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: CODEX_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: session.refreshToken
		})
	});
	if (!response.ok) throw await oauthEndpointError(response, "codex");
	return codexSession(await response.json(), session);
}
/**
* Whether a codex refresh failure means the login is permanently gone.
* @param error - the thrown refresh error.
* @returns true when re-login is the only fix.
*/
function isCodexPermanentRefreshError(error) {
	return error instanceof OAuthEndpointError && error.oauthCode !== void 0 && PERMANENT_REFRESH_CODES.has(error.oauthCode);
}
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** Seconds of the canonical 5-hour session and 7-day weekly windows. */
const SESSION_WINDOW_SECONDS = 300 * 60;
const WEEKLY_WINDOW_SECONDS = 10080 * 60;
/** Whether a reported duration approximately matches the expected window length. */
function matchesWindow(seconds, expected) {
	return seconds >= expected * .95 && seconds <= expected * 1.05;
}
/**
* Classify a wham/usage window by its reported duration. The backend has been
* observed to place the weekly lane in `primary_window` with no secondary
* window, so slot position alone is unreliable; the caller's positional
* fallback applies only when the duration is absent.
*/
function codexWindowKind(window, fallback) {
	const seconds = window.limit_window_seconds;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
	if (matchesWindow(seconds, SESSION_WINDOW_SECONDS)) return "session";
	if (matchesWindow(seconds, WEEKLY_WINDOW_SECONDS)) return "weekly";
	return "other";
}
/** Map one wham/usage window into a {@link UsageWindow}; undefined when unusable. */
function codexUsageWindow(value, fallbackKind) {
	if (typeof value !== "object" || value === null) return void 0;
	const window = value;
	if (typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return void 0;
	let resetsAt;
	if (typeof window.reset_at === "number" && window.reset_at > 0) resetsAt = window.reset_at * 1e3;
	else if (typeof window.reset_after_seconds === "number" && window.reset_after_seconds > 0) resetsAt = Date.now() + window.reset_after_seconds * 1e3;
	return {
		kind: codexWindowKind(window, fallbackKind),
		usedPercent: window.used_percent,
		...resetsAt === void 0 ? {} : { resetsAt }
	};
}
/**
* Fetch the codex subscription usage from the ChatGPT backend wham/usage
* endpoint (the source of the codex CLI `/status` rate-limit lines). The
* windows are classified by their reported duration (`limit_window_seconds`)
* rather than by slot, since the backend has been observed to report the
* weekly lane as `primary_window` without a secondary window; slot order is
* kept only as a fallback when the duration is absent. The lookup itself
* consumes no rate-limit budget.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation from the RPC transport.
* @returns the mapped usage snapshot.
*/
async function fetchCodexUsage(session, fetchFn = fetch, signal) {
	const response = await fetchFn(CODEX_USAGE_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"chatgpt-account-id": session.accountId,
			"originator": "codex_cli_rs",
			"accept": "application/json",
			...attributionHeaders()
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "codex usage");
	const payload = await response.json();
	const windows = [];
	const primary = codexUsageWindow(payload.rate_limit?.primary_window, "session");
	const secondary = codexUsageWindow(payload.rate_limit?.secondary_window, "weekly");
	if (primary !== void 0) windows.push(primary);
	if (secondary !== void 0) windows.push(secondary);
	return {
		supported: true,
		windows,
		...typeof payload.plan_type === "string" && payload.plan_type.length > 0 ? { plan: payload.plan_type } : {}
	};
}
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
/**
* Client version sent on the /models catalog request. The backend gates the
* visible model list by client version: versions below ~0.101 get an empty
* list, while current codex CLI releases get the full catalog â€” keep this in
* the range of current codex CLI releases.
*/
const CODEX_CLIENT_VERSION = "0.147.0";
/** Display name for a wire reasoning-effort value. */
function effortName(effort) {
	return effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1);
}
/**
* Whether a catalog entry advertises the fast tier. Mirrors codex-rs
* `ModelPreset::supports_fast_mode`: a `service_tiers` id matching the fast
* wire value, or the legacy `additional_speed_tiers` "fast" entry.
*/
function supportsFastTier(entry) {
	return (entry.service_tiers ?? []).some((tier) => tier.id === CODEX_FAST_SERVICE_TIER) || (entry.additional_speed_tiers ?? []).includes(CODEX_FAST_SPEED_TIER);
}
/**
* Fetch the live codex model catalog with the session's auth headers.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @returns discovered models: hidden entries dropped, sorted by priority.
*/
async function fetchCodexModels(session, fetchFn = fetch) {
	const response = await fetchFn(`${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`, { headers: {
		"authorization": `Bearer ${session.accessToken}`,
		"chatgpt-account-id": session.accountId,
		"originator": "codex_cli_rs",
		"accept": "application/json",
		...attributionHeaders()
	} });
	if (!response.ok) throw await oauthEndpointError(response, "codex models");
	const payload = await response.json();
	if (!Array.isArray(payload.models)) throw new Error("codex models endpoint returned no models array");
	const discovered = [];
	for (const entry of payload.models) {
		if (typeof entry.slug !== "string" || entry.slug.length === 0) continue;
		if (entry.visibility === "hide" || entry.visibility === "none") continue;
		const efforts = (entry.supported_reasoning_levels ?? []).filter((level) => typeof level.effort === "string" && level.effort.length > 0).map((level) => ({
			id: ReasoningEffortId(level.effort),
			name: effortName(level.effort),
			...level.description === void 0 ? {} : { description: level.description }
		}));
		const defaultEffort = typeof entry.default_reasoning_level === "string" && entry.default_reasoning_level.length > 0 && efforts.some((effort) => effort.id === ReasoningEffortId(entry.default_reasoning_level)) ? ReasoningEffortId(entry.default_reasoning_level) : void 0;
		const model = {
			id: entry.slug,
			name: typeof entry.display_name === "string" && entry.display_name.length > 0 ? entry.display_name : entry.slug,
			...typeof entry.description === "string" && entry.description.length > 0 ? { description: entry.description } : {},
			...typeof entry.context_window === "number" && entry.context_window > 0 ? { contextWindow: entry.context_window } : {},
			...typeof entry.priority === "number" ? { priority: entry.priority } : {},
			...efforts.length > 0 ? { reasoning: {
				efforts,
				...defaultEffort === void 0 ? {} : { defaultEffort }
			} } : {},
			...supportsFastTier(entry) ? { fastTier: true } : {}
		};
		discovered.push(model);
	}
	discovered.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
	if (discovered.length === 0) throw new Error(`codex models endpoint returned an empty catalog (client_version ${CODEX_CLIENT_VERSION})`);
	return discovered;
}
/**
* The Responses request body for one generation. A fast-tier request (the
* composer Speed toggle, the codex CLI's fast mode) carries
* `service_tier: priority`; the tier field is omitted entirely otherwise,
* matching the CLI (it never sends an explicit standard tier).
*/
function codexRequestBody(options, resolved, fast) {
	return {
		model: options.model,
		instructions: resolved.instructions ?? DEFAULT_CODEX_INSTRUCTIONS,
		input: resolved.input,
		...options.tools !== void 0 && options.tools.length > 0 ? { tools: toResponsesTools(options.tools), tool_choice: "auto", parallel_tool_calls: true } : {},
		...options.reasoningEffort !== void 0 ? { reasoning: {
			effort: String(options.reasoningEffort),
			summary: "auto"
		} } : {},
		store: false,
		stream: true,
		include: ["reasoning.encrypted_content"],
		...options.sessionId !== void 0 ? { prompt_cache_key: String(options.sessionId) } : {},
		...fast ? { service_tier: CODEX_FAST_SERVICE_TIER } : {}
	};
}
/** Codex wire adapter: one instance serves the `codex` provider route. */
var CodexAdapter = class extends LlmAdapter {
	catalog;
	constructor(options) {
		super();
		this.options = options;
		this.catalog = new ModelCatalogCache(options.catalogStore);
	}
	/** Discovery fetcher: resolves the session through the refresh-aware path. */
	async fetchCatalog() {
		return fetchCodexModels(await this.options.tokens.session(), this.options.fetchFn);
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "ChatGPT (Codex)"
		};
	}
	staticModels(provider) {
		return this.options.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: model.inputModalities ?? CODEX_MODALITIES
		}));
	}
	async listModels(provider) {
		if (await this.options.tokens.peek() === void 0) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		try {
			return (await this.catalog.get(() => this.fetchCatalog())).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				...model.description === void 0 ? {} : { description: model.description },
				inputModalities: CODEX_MODALITIES
			}));
		} catch (error) {
			if (error instanceof LlmError && (error.code === "MISSING_CREDENTIAL" || error.code === "INVALID_CREDENTIAL")) return [];
			if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate();
			this.options.onWarn?.(`codex model discovery failed; using the built-in catalog (${errorChain(error)})`);
			return this.staticModels(provider);
		}
	}
	/**
	* The discovered entry for one model. Resolved through the cache's
	* stale-while-revalidate path so capability metadata stays stable across a
	* long conversation: a discovered-only effort (one missing from the static
	* CODEX_EFFORTS list) selected by the user must not vanish â€” and fail the
	* call â€” just because the TTL lapsed mid-turn.
	*/
	async discovered(model) {
		if (!this.options.discovery) return void 0;
		return (await this.catalog.resolve(() => this.fetchCatalog()))?.find((entry) => entry.id === model);
	}
	/** Whether the discovered catalog advertises a fast tier for this model. */
	async supportsFastTier(model) {
		return (await this.discovered(model))?.fastTier === true;
	}
	/** Ids of every discovered model with a fast tier (the Speed toggle's visibility list). */
	async fastCapableModels() {
		if (!this.options.discovery) return [];
		if (await this.options.tokens.peek() === void 0) return [];
		return (await this.catalog.resolve(() => this.fetchCatalog()) ?? []).filter((model) => model.fastTier === true).map((model) => model.id);
	}
	async resolveModel(provider, model) {
		const discovered = await this.discovered(model);
		const configured = this.options.models.find((entry) => entry.id === model);
		return {
			provider,
			id: model,
			name: discovered?.name ?? configured?.name ?? model,
			...discovered?.description === void 0 ? {} : { description: discovered.description },
			inputModalities: configured?.inputModalities ?? CODEX_MODALITIES,
			context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? CODEX_CONTEXT_WINDOW },
			defaultMaxTokens: configured?.maxTokens ?? CODEX_DEFAULT_MAX_TOKENS,
			reasoning: discovered?.reasoning ?? {
				efforts: CODEX_EFFORTS,
				defaultEffort: CODEX_DEFAULT_EFFORT
			}
		};
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			let session = await this.options.tokens.session();
			let response;
			try {
				response = await this.request(options, session, watchdog.signal);
			} catch (first) {
				if (!isDeadProxyError(first)) throw first;
				response = await this.requestDirect(options, session, watchdog.signal);
			}
			if (response.status === 401) {
				session = await this.options.tokens.session(true);
				response = await this.request(options, session, watchdog.signal);
			}
			if (!response.ok) throw await httpLlmError(response, "codex API");
			if (response.body === null) throw new LlmError("codex API returned no response body", EMPTY_RESPONSE_CODE);
			yield* streamResponses(response.body, () => {
				watchdog.pulse();
			});
		} catch (error) {
			throw mapFetchFailure("codex API", error, watchdog, options.signal);
		} finally {
			watchdog.stop();
		}
	}
	async requestDirect(options, session, signal) {
		return this.requestWithFetch(options, session, signal, fetchDirect);
	}
	async request(options, session, signal) {
		return this.requestWithFetch(options, session, signal, fetch);
	}
	async requestWithFetch(options, session, signal, fetchFn) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const fast = this.options.speedFor !== void 0 && await this.options.speedFor(options.sessionId, options.model);
		const body = codexRequestBody(options, toResponsesInput(messages, options.system), fast);
		return fetchFn(CODEX_API_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"chatgpt-account-id": session.accountId,
				"originator": "codex_cli_rs",
				"session-id": randomUUID(),
				"accept": "text/event-stream",
				"content-type": "application/json",
				...attributionHeaders()
			},
			body: JSON.stringify(body),
			signal
		});
	}
};

//#endregion
//#region src/translate/anthropic.ts
/**
* The Claude Code identity block. The subscription endpoint rejects requests
* that do not present as Claude Code, so this block is REQUIRED as the first
* system entry on every request.
*/
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Flatten a tool result's content to plain text for `tool_result`. */
function toolResultText(block) {
	return block.content.map((part) => part.type === "text" ? part.text : "").join("");
}
/** Parse a tool call's raw JSON arguments into Anthropic's object-shaped `input`. */
function parseToolInput(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
		return {};
	} catch {
		return {};
	}
}
/**
* Convert harness messages into Anthropic messages. Consecutive same-role
* messages merge into one message with multiple content blocks; tool results
* arrive as user messages with `tool_result` blocks; system-role messages are
* handled by {@link toAnthropicSystem} and skipped here. Reasoning blocks are
* not replayed (v1). Images must arrive pre-resolved
* ({@link TranslatableMessage}); an unresolved ImageBlock is skipped because
* its bytes are unreachable here.
* @param messages - ordered conversation messages with resolved images.
* @returns Anthropic messages in conversation order.
*/
function toAnthropicMessages(messages) {
	const out = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		const role = message.role;
		const blocks = [];
		for (const block of message.content) switch (block.type) {
			case "text":
				blocks.push({
					type: "text",
					text: block.text
				});
				break;
			case "tool-call":
				blocks.push({
					type: "tool_use",
					id: String(block.id),
					name: block.name,
					input: parseToolInput(block.arguments)
				});
				break;
			case "tool-result":
				blocks.push({
					type: "tool_result",
					tool_use_id: String(block.toolCallId),
					content: toolResultText(block),
					...block.isError === true ? { is_error: true } : {}
				});
				break;
			case "image":
				if ("dataBase64" in block) blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mediaType,
						data: block.dataBase64
					}
				});
				break;
			default: break;
		}
		if (blocks.length === 0) continue;
		const last = out[out.length - 1];
		if (last !== void 0 && last.role === role) last.content.push(...blocks);
		else out.push({
			role,
			content: blocks
		});
	}
	return out;
}
/**
* Build the Anthropic `system` array: the mandatory Claude Code identity
* block, then the explicit system prompt, then any system-role messages.
* @param system - explicit system prompt, when set.
* @param messages - conversation messages; their system-role text is appended.
* @returns the system content blocks.
*/
function toAnthropicSystem(system, messages) {
	const blocks = [{
		type: "text",
		text: CLAUDE_CODE_IDENTITY
	}];
	if (system !== void 0 && system.length > 0) blocks.push({
		type: "text",
		text: system
	});
	for (const message of messages ?? []) {
		if (message.role !== "system") continue;
		for (const block of message.content) if (block.type === "text") blocks.push({
			type: "text",
			text: block.text
		});
	}
	return blocks;
}
/**
* Map harness tool schemas to Anthropic tools.
* @param tools - tool schemas from the request.
* @returns Anthropic `tools` array entries.
*/
function toAnthropicTools(tools) {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters
	}));
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: ToolCallId(block.callId),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Classify an Anthropic `error` event into a thrown LlmError.
* @param error - the wire error object.
* @returns the mapped error.
*/
function anthropicFailure(error) {
	const type = error?.type ?? "unknown_error";
	const message = error?.message ?? `Anthropic reported ${type}`;
	if (type === "invalid_request_error" && /prompt is too long/i.test(message)) return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE);
	if (type === "rate_limit_error") return new LlmError(message, "RATE_LIMIT");
	if (type === "authentication_error") return new LlmError(message, "AUTH");
	return new LlmError(message, "SERVER");
}
/**
* Push-model Anthropic SSE translator: feed each parsed event object to
* {@link push} and collect the emitted harness StreamChunks. Block indexes
* are allocated in first-seen order; `usage` is emitted before the terminal
* `finish`, and nothing is emitted after it. `error` events throw
* {@link LlmError}.
*/
var AnthropicStreamTranslator = class {
	blocks = /* @__PURE__ */ new Map();
	nextIndex = 0;
	sawAnyBlock = false;
	pendingUsage;
	outputTokens;
	stopReason = "stop";
	usageEmitted = false;
	/** Set once `message_stop` produced the terminal finish chunk. */
	terminated = false;
	open(wireIndex, kind, chunks, callId = "", name$1) {
		const block = {
			index: this.nextIndex++,
			kind,
			text: "",
			callId,
			...name$1 === void 0 ? {} : { name: name$1 }
		};
		this.blocks.set(wireIndex, block);
		this.sawAnyBlock = true;
		chunks.push({
			type: "block-start",
			index: block.index,
			blockType: kind
		});
		return block;
	}
	emitUsage(chunks) {
		if (this.usageEmitted) return;
		this.usageEmitted = true;
		const usage = {
			inputTokens: this.pendingUsage?.inputTokens ?? 0,
			outputTokens: this.outputTokens ?? 0,
			...this.pendingUsage?.cacheReadTokens !== void 0 ? { cacheReadTokens: this.pendingUsage.cacheReadTokens } : {},
			...this.pendingUsage?.cacheWriteTokens !== void 0 ? { cacheWriteTokens: this.pendingUsage.cacheWriteTokens } : {}
		};
		chunks.push({
			type: "usage",
			usage
		});
	}
	/**
	* Process one parsed Anthropic SSE event.
	* @param event - the parsed event object.
	* @returns the StreamChunks this event produced (possibly none).
	*/
	push(event) {
		if (this.terminated) return [];
		const chunks = [];
		switch (event.type) {
			case "message_start": {
				const usage = event.message?.usage;
				if (usage !== void 0) {
					this.pendingUsage = {
						inputTokens: usage.input_tokens ?? 0,
						...usage.cache_read_input_tokens !== void 0 ? { cacheReadTokens: usage.cache_read_input_tokens } : {},
						...usage.cache_creation_input_tokens !== void 0 ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}
					};
					this.outputTokens = usage.output_tokens ?? this.outputTokens;
				}
				return chunks;
			}
			case "content_block_start": {
				const wireIndex = event.index ?? 0;
				const block = event.content_block;
				switch (block?.type) {
					case "text":
						this.open(wireIndex, "text", chunks);
						break;
					case "thinking":
						this.open(wireIndex, "reasoning", chunks);
						break;
					case "tool_use": {
						const opened = this.open(wireIndex, "tool-call", chunks, block.id ?? "", block.name);
						chunks.push({
							type: "tool-call-delta",
							index: opened.index,
							id: ToolCallId(opened.callId),
							...block.name === void 0 ? {} : { name: block.name },
							argumentsDelta: ""
						});
						break;
					}
					default: break;
				}
				return chunks;
			}
			case "content_block_delta": {
				const wireIndex = event.index ?? 0;
				const block = this.blocks.get(wireIndex);
				const delta = event.delta;
				if (block === void 0 || delta === void 0) return chunks;
				switch (delta.type) {
					case "text_delta":
						block.text += delta.text ?? "";
						chunks.push({
							type: "text-delta",
							index: block.index,
							text: delta.text ?? ""
						});
						break;
					case "thinking_delta":
						block.text += delta.thinking ?? "";
						chunks.push({
							type: "reasoning-delta",
							index: block.index,
							text: delta.thinking ?? ""
						});
						break;
					case "input_json_delta":
						block.text += delta.partial_json ?? "";
						chunks.push({
							type: "tool-call-delta",
							index: block.index,
							id: ToolCallId(block.callId),
							...block.name === void 0 ? {} : { name: block.name },
							argumentsDelta: delta.partial_json ?? ""
						});
						break;
					default: break;
				}
				return chunks;
			}
			case "content_block_stop": {
				const wireIndex = event.index ?? 0;
				const block = this.blocks.get(wireIndex);
				if (block === void 0) return chunks;
				this.blocks.delete(wireIndex);
				chunks.push({
					type: "block-end",
					index: block.index,
					block: closeBlock(block)
				});
				return chunks;
			}
			case "message_delta":
				if (event.usage?.output_tokens !== void 0) this.outputTokens = event.usage.output_tokens;
				switch (event.delta?.stop_reason) {
					case "end_turn":
					case "stop_sequence":
						this.stopReason = "stop";
						break;
					case "tool_use":
						this.stopReason = "tool-calls";
						break;
					case "max_tokens":
						this.stopReason = "max-tokens";
						break;
					default: break;
				}
				return chunks;
			case "message_stop":
				this.terminated = true;
				for (const [wireIndex, block] of [...this.blocks]) {
					this.blocks.delete(wireIndex);
					chunks.push({
						type: "block-end",
						index: block.index,
						block: closeBlock(block)
					});
				}
				this.emitUsage(chunks);
				if (this.stopReason === "stop" && !this.sawAnyBlock) chunks.push({
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: "model returned a completed response with no content",
							code: EMPTY_RESPONSE_CODE
						}
					}
				});
				else chunks.push({
					type: "finish",
					reason: { kind: this.stopReason }
				});
				return chunks;
			case "error": throw anthropicFailure(event.error);
			default: return chunks;
		}
	}
};
/**
* Consume an Anthropic SSE byte stream and yield harness StreamChunks.
* @param stream - raw response body.
* @param onActivity - transport-activity callback for the idle watchdog.
* @returns the chunk stream; throws when the stream ends before `message_stop`.
*/
async function* streamAnthropic(stream, onActivity) {
	const translator = new AnthropicStreamTranslator();
	for await (const sseEvent of parseSse(stream, onActivity)) {
		let event;
		try {
			event = JSON.parse(sseEvent.data);
		} catch {
			throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		if (typeof event.message?.model === 'string') yield { type: 'response-model', model: event.message.model };
		yield* translator.push(event);
		if (translator.terminated) return;
	}
	throw new LlmError("Anthropic SSE stream ended before message_stop", "STREAM_CLOSED");
}

//#endregion
//#region src/providers/claude.ts
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_TOKEN_URL = "https://claude.ai/v1/oauth/token";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages?beta=true";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?beta=true";
const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_CONTEXT_WINDOW = 2e5;
const CLAUDE_DEFAULT_MAX_TOKENS = 32e3;
/** Refresh when the access token has less than this much life left. */
const CLAUDE_PREEMPT_MS = 5 * 6e4;
/**
* The subscription endpoint only serves requests presenting as Claude Code,
* so these headers impersonate the CLI; the harness attribution user-agent
* cannot be sent here (one user-agent slot, and the CLI's wins).
*/
const CLAUDE_CLI_FALLBACK_VERSION = "2.1.234";
function detectClaudeVersion() {
	try {
		const match = execFileSync("claude", ["--version"], {
			timeout: 3e3,
			encoding: "utf8"
		}).match(/^(\d+\.\d+\.\d+)/);
		if (match) return match[1];
	} catch {}
	return CLAUDE_CLI_FALLBACK_VERSION;
}
let claudeCliUserAgent;
function getClaudeCliUserAgent() {
	if (claudeCliUserAgent === void 0) claudeCliUserAgent = `claude-cli/${detectClaudeVersion()} (external, cli)`;
	return claudeCliUserAgent;
}
const CLAUDE_BETA_FALLBACK = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"effort-2025-11-24",
	"compact-2026-01-12",
	"files-api-2025-04-14"
].join(",");
const CLAUDE_BETA_FLAGS = CLAUDE_BETA_FALLBACK;
/** Best-effort account profile; login must not fail when this does. */
async function fetchClaudeProfile(accessToken, signal) {
	try {
		const response = await fetch(CLAUDE_PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal });
		if (!response.ok) return {};
		const profile = await response.json();
		const account = typeof profile.account === "object" && profile.account !== null ? profile.account : {};
		const email = profile.emailAddress ?? profile.email ?? account.email_address ?? account.email;
		const subscription = profile.subscriptionType ?? profile.subscription_type ?? account.subscription_type;
		return {
			...typeof email === "string" && email.length > 0 ? { emailAddress: email } : {},
			...typeof subscription === "string" && subscription.length > 0 ? { subscriptionType: subscription } : {}
		};
	} catch {
		return {};
	}
}
/** Build a session from a token response. */
async function claudeSession(tokens, fallbackRefreshToken, withProfile, signal) {
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new Error("claude token endpoint returned no access token");
	const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;
	if (refreshToken === void 0) throw new Error("claude token endpoint returned no refresh token");
	if (typeof tokens.expires_in !== "number" || tokens.expires_in <= 0) throw new Error("claude token endpoint returned no usable expiry");
	const profile = withProfile ? await fetchClaudeProfile(tokens.access_token, signal) : {};
	return {
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt: Date.now() + tokens.expires_in * 1e3,
		scopes: tokens.scope ?? CLAUDE_SCOPE,
		...profile
	};
}
/**
* Exchange an authorization code for a claude session (JSON grant).
* @param code - the authorization code from the callback.
* @param verifier - the PKCE verifier minted for the attempt.
* @param redirectUri - the attempt's redirect URI.
* @param state - the attempt's state (echoed to the token endpoint).
* @returns the session to store.
*/
async function exchangeClaudeCode(code, verifier, redirectUri, state, signal) {
	const response = await fetch(CLAUDE_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CLAUDE_CLIENT_ID,
			code_verifier: verifier,
			state
		}), signal
	});
	if (!response.ok) throw await oauthEndpointError(response, "claude");
	return claudeSession(await response.json(), void 0, true, signal);
}
/**
* Refresh a claude session (JSON grant echoing the issued scope).
* @param session - the stored session.
* @returns the fresh session to store.
*/
async function refreshClaude(session) {
	const response = await fetch(CLAUDE_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: session.refreshToken,
			client_id: CLAUDE_CLIENT_ID,
			scope: session.scopes
		})
	});
	if (!response.ok) throw await oauthEndpointError(response, "claude");
	return {
		...await claudeSession(await response.json(), session.refreshToken, false),
		...session.emailAddress === void 0 ? {} : { emailAddress: session.emailAddress },
		...session.subscriptionType === void 0 ? {} : { subscriptionType: session.subscriptionType }
	};
}
/**
* Whether a claude refresh failure means the login is permanently gone.
* @param error - the thrown refresh error.
* @returns true when re-login is the only fix.
*/
function isClaudePermanentRefreshError(error) {
	return error instanceof OAuthEndpointError && (error.oauthCode === "invalid_grant" || error.oauthCode === "invalid_token");
}
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** RFC3339 `resets_at` value â†’ epoch ms, or undefined when absent/unparsable. */
function claudeResetsAt(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/** Map one legacy `{utilization, resets_at}` bucket; undefined when null or unusable. */
function claudeLegacyWindow(value, kind, scope) {
	if (typeof value !== "object" || value === null) return void 0;
	const bucket = value;
	if (typeof bucket.utilization !== "number" || !Number.isFinite(bucket.utilization)) return void 0;
	const resetsAt = claudeResetsAt(bucket.resets_at);
	return {
		kind,
		...scope === void 0 ? {} : { scope },
		usedPercent: bucket.utilization,
		...resetsAt === void 0 ? {} : { resetsAt }
	};
}
/** Map the modern `limits` array; empty when absent or carrying nothing usable. */
function claudeLimitsWindows(value) {
	if (!Array.isArray(value)) return [];
	const windows = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw;
		if (typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) continue;
		const kind = entry.kind === "session" ? "session" : entry.kind === "weekly_all" || entry.kind === "weekly_scoped" ? "weekly" : "other";
		const scope = entry.scope?.model?.display_name;
		const resetsAt = claudeResetsAt(entry.resets_at);
		windows.push({
			kind,
			...typeof scope === "string" && scope.length > 0 ? { scope } : {},
			usedPercent: entry.percent,
			...resetsAt === void 0 ? {} : { resetsAt }
		});
	}
	return windows;
}
/**
* Fetch the claude subscription usage from the OAuth usage endpoint (the
* source of Claude Code's `/usage` screen). Newer responses carry a
* structured `limits` array; older ones the flat `five_hour`/`seven_day*`
* buckets â€” both shapes are read, the array winning when it has entries.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation from the RPC transport.
* @returns the mapped usage snapshot.
*/
async function fetchClaudeUsage(session, fetchFn = fetch, signal) {
	const response = await fetchFn(CLAUDE_USAGE_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"anthropic-beta": "oauth-2025-04-20",
			"user-agent": getClaudeCliUserAgent(),
			"accept": "application/json"
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "claude usage");
	const payload = await response.json();
	const modern = claudeLimitsWindows(payload.limits);
	if (modern.length > 0) return {
		supported: true,
		windows: modern
	};
	const windows = [];
	const legacy = [
		claudeLegacyWindow(payload.five_hour, "session"),
		claudeLegacyWindow(payload.seven_day, "weekly"),
		claudeLegacyWindow(payload.seven_day_opus, "weekly", "Opus"),
		claudeLegacyWindow(payload.seven_day_sonnet, "weekly", "Sonnet")
	];
	for (const window of legacy) if (window !== void 0) windows.push(window);
	return {
		supported: true,
		windows
	};
}
function claudeThinkingType(capabilities) {
	const types = capabilities?.thinking?.types;
	if (types?.enabled?.supported === true) return "enabled";
	if (types?.adaptive?.supported === true) return "adaptive";
}
/** Effort levels in display order; a model exposes only the ones it advertises as supported. */
const CLAUDE_EFFORT_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function claudeReasoning(capabilities) {
	const effort = capabilities?.effort;
	if (effort?.supported !== true) return void 0;
	const efforts = CLAUDE_EFFORT_LEVELS.filter((level) => effort[level]?.supported === true).map((level) => ({
		id: ReasoningEffortId(level),
		name: level[0].toUpperCase() + level.slice(1)
	}));
	return efforts.length > 0 ? { efforts } : void 0;
}
/** Fetch the live model catalog from the subscription endpoint. */
async function fetchClaudeModels(session, fetchFn = fetch) {
	const response = await fetchFn(CLAUDE_MODELS_URL, { headers: {
		"authorization": `Bearer ${session.accessToken}`,
		"anthropic-version": "2023-06-01",
		"user-agent": getClaudeCliUserAgent(),
		"anthropic-dangerous-direct-browser-access": "true",
		"accept": "application/json"
	} });
	if (!response.ok) throw await httpLlmError(response, "claude models API");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("claude models API returned an invalid catalog");
	const models = payload.data.filter((m) => typeof m.id === "string").map((m) => {
		const thinkingType = claudeThinkingType(m.capabilities);
		const reasoning = claudeReasoning(m.capabilities);
		return {
			id: m.id,
			name: m.display_name ?? m.id,
			...thinkingType === void 0 ? {} : { thinkingType },
			...reasoning === void 0 ? {} : { reasoning }
		};
	});
	if (models.length === 0) throw new Error("claude models API returned an empty catalog");
	return models;
}
/**
* Claude Code's own SDK retry shape: exponential backoff starting at 1s,
* doubling per attempt, capped at 60s, plus jitter. `maxRetries` is the
* count of retries after the first attempt (Claude Code defaults to 10).
*/
const CLAUDE_RETRY_INITIAL_DELAY_MS = 1e3;
const CLAUDE_RETRY_MAX_DELAY_MS = 6e4;
const CLAUDE_RETRY_JITTER_RATIO = .2;
/** The Claude 4.5 family accepts image input. */
const CLAUDE_MODALITIES = ["text", "image"];
/** Claude wire adapter: one instance serves the `claude` provider route. */
var ClaudeAdapter = class extends LlmAdapter {
	catalog;
	constructor(options) {
		super();
		this.options = options;
		this.catalog = new ModelCatalogCache(options.catalogStore);
	}
	async fetchCatalog() {
		return fetchClaudeModels(await this.options.tokens.session(), this.options.fetchFn);
	}
	async discovered(model) {
		if (!this.options.discovery) return void 0;
		return (await this.catalog.resolve(() => this.fetchCatalog()))?.find((entry) => entry.id === model);
	}
	staticModels(provider) {
		return this.options.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: model.inputModalities ?? CLAUDE_MODALITIES
		}));
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Claude (Subscription)"
		};
	}
	providerRetryPolicy(provider) {
		if (this.options.maxRetries === void 0) return void 0;
		return resolveRetryPolicy({
			mode: "normal",
			maxRetries: this.options.maxRetries,
			backoff: {
				initialDelayMs: CLAUDE_RETRY_INITIAL_DELAY_MS,
				maxDelayMs: CLAUDE_RETRY_MAX_DELAY_MS,
				jitterRatio: CLAUDE_RETRY_JITTER_RATIO
			}
		}, `claude: provider "${provider}" retryPolicy`);
	}
	async listModels(provider) {
		if (await this.options.tokens.peek() === void 0) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		try {
			return (await this.catalog.get(() => this.fetchCatalog())).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				inputModalities: CLAUDE_MODALITIES
			}));
		} catch (error) {
			if (error instanceof LlmError && (error.code === "MISSING_CREDENTIAL" || error.code === "INVALID_CREDENTIAL")) return [];
			if (error instanceof LlmError && error.code === "AUTH") this.catalog.invalidate();
			this.options.onWarn?.(`claude model discovery failed; using the built-in catalog (${errorChain(error)})`);
			return this.staticModels(provider);
		}
	}
	async resolveModel(provider, model) {
		const disc = await this.discovered(model);
		const configured = this.options.models.find((entry) => entry.id === model);
		const reasoning = disc?.reasoning;
		return {
			provider,
			id: model,
			name: disc?.name ?? configured?.name ?? model,
			inputModalities: configured?.inputModalities ?? CLAUDE_MODALITIES,
			context: { contextWindow: disc?.contextWindow ?? configured?.contextWindow ?? CLAUDE_CONTEXT_WINDOW },
			defaultMaxTokens: configured?.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			let session = await this.options.tokens.session();
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) {
				session = await this.options.tokens.session(true);
				response = await this.request(options, session, watchdog.signal);
			}
			if (!response.ok) throw await httpLlmError(response, "claude API");
			if (response.body === null) throw new LlmError("claude API returned no response body", EMPTY_RESPONSE_CODE);
			yield* streamAnthropic(response.body, () => {
				watchdog.pulse();
			});
		} catch (error) {
			throw mapFetchFailure("claude API", error, watchdog, options.signal);
		} finally {
			watchdog.stop();
		}
	}
	/**
	* `display: 'summarized'` is set explicitly on both shapes: `adaptive`-type
	* models default to `display: 'omitted'`, which returns thinking blocks with
	* an empty `thinking` field â€” without this override the "Think" panel would
	* always render empty even though real reasoning (and billed thinking_tokens)
	* ran.
	*/
	thinkingParam(thinkingType, maxTokens) {
		if (thinkingType === "adaptive") return {
			type: "adaptive",
			display: "summarized"
		};
		if (thinkingType === "enabled") {
			const budget = Math.min(Math.max(1024, Math.floor(maxTokens * .5)), maxTokens - 100);
			if (budget < 1024) return void 0;
			return {
				type: "enabled",
				budget_tokens: budget,
				display: "summarized"
			};
		}
	}
	async request(options, session, signal) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const maxTokens = options.maxTokens ?? this.options.models.find((entry) => entry.id === options.model)?.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS;
		const disc = await this.discovered(options.model);
		const thinking = this.thinkingParam(disc?.thinkingType, maxTokens);
		const effort = options.reasoningEffort !== void 0 && disc?.reasoning !== void 0 ? { output_config: { effort: String(options.reasoningEffort) } } : {};
		const body = {
			model: options.model,
			max_tokens: maxTokens,
			system: toAnthropicSystem(options.system, messages),
			messages: toAnthropicMessages(messages),
			...options.tools !== void 0 && options.tools.length > 0 ? { tools: toAnthropicTools(options.tools) } : {},
			...thinking === void 0 ? {} : { thinking },
			...effort,
			stream: true,
			...options.sessionId !== void 0 ? { metadata: { user_id: String(options.sessionId) } } : {}
		};
		return fetch(CLAUDE_API_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": CLAUDE_BETA_FLAGS,
				"user-agent": getClaudeCliUserAgent(),
				"x-app": "cli",
				"anthropic-dangerous-direct-browser-access": "true",
				"accept": "text/event-stream",
				"content-type": "application/json"
			},
			body: JSON.stringify(body),
			signal
		});
	}
};

//#endregion
//#region src/providers/grok.ts
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const GROK_API_URL = "https://api.x.ai/v1/responses";
const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const GROK_CALLBACK_PATH = "/callback";
const GROK_CONTEXT_WINDOW = 256e3;
const GROK_DEFAULT_MAX_TOKENS = 32e3;
/** Refresh when the access token has less than this much life left. */
const GROK_PREEMPT_MS = 2 * 6e4;
/** A discovered URL must be https on x.ai or a subdomain; anything else is a hostile document. */
function assertXaiEndpoint(url, field) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`grok OIDC discovery returned an invalid ${field}`);
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "x.ai" && !parsed.hostname.endsWith(".x.ai")) throw new Error(`grok OIDC discovery returned a non-x.ai ${field}: ${url}`);
	return url;
}
let discoveryCache;
/**
* Resolve the xAI OIDC endpoints (cached after the first fetch).
* @returns validated authorization and token endpoints.
*/
async function grokDiscovery(signal) {
	if (discoveryCache !== void 0) return discoveryCache;
	const response = await fetch(GROK_DISCOVERY_URL, { signal });
	if (!response.ok) throw await oauthEndpointError(response, "grok OIDC discovery");
	const document = await response.json();
	if (typeof document.authorization_endpoint !== "string" || typeof document.token_endpoint !== "string") throw new Error("grok OIDC discovery document is missing endpoints");
	discoveryCache = {
		authorizationEndpoint: assertXaiEndpoint(document.authorization_endpoint, "authorization_endpoint"),
		tokenEndpoint: assertXaiEndpoint(document.token_endpoint, "token_endpoint")
	};
	return discoveryCache;
}
/**
* Build the grok flow facts for the OAuth flow engine (async because the
* authorize URL comes from OIDC discovery).
* @returns the flow spec for one attempt.
*/
async function grokFlow(signal) {
	const discovery = await grokDiscovery(signal);
	return {
		callbackPath: GROK_CALLBACK_PATH,
		listen: {
			host: "127.0.0.1",
			ports: [56121]
		},
		buildAuthorizeUrl({ redirectUri, state, pkce, nonce }) {
			const params = new URLSearchParams({
				response_type: "code",
				client_id: GROK_CLIENT_ID,
				redirect_uri: redirectUri,
				scope: GROK_SCOPE,
				code_challenge: pkce.challenge,
				code_challenge_method: "S256",
				state,
				nonce,
				plan: "generic",
				referrer: "dsh-plugin-subscriptions"
			});
			return `${discovery.authorizationEndpoint}?${params.toString()}`;
		}
	};
}
/**
* Display names for the numeric `tier` claim xAI stamps on OAuth access
* tokens (the `prod_auth.SubscriptionTier` proto enum; the mapping mirrors
* grok-build's `jwt_tier_claim`). Unknown values fall through to the raw
* number so a future tier still shows something.
*/
const GROK_TIER_NAMES = {
	0: "Free",
	1: "SuperGrok",
	2: "X Basic",
	3: "X Premium",
	4: "X Premium+",
	5: "SuperGrok Heavy",
	6: "SuperGrok Lite",
	7: "SuperGrok Plus"
};
/**
* The subscription tier encoded in a grok access token's `tier` claim (no
* verification â€” same trust posture as the other claim reads).
* @param accessToken - the stored access token.
* @returns the display tier name, or undefined when the claim is absent.
*/
function grokTierName(accessToken) {
	const tier = decodeJwtPayload(accessToken)?.tier;
	if (typeof tier !== "number" || !Number.isInteger(tier)) return void 0;
	return GROK_TIER_NAMES[tier] ?? String(tier);
}
/** Pick a display account from an id token's claims. */
function grokAccount(idToken) {
	const payload = idToken === void 0 ? void 0 : decodeJwtPayload(idToken);
	const claim = payload?.email ?? payload?.preferred_username ?? payload?.name ?? payload?.sub;
	return typeof claim === "string" && claim.length > 0 ? claim : void 0;
}
/** Build a session from a token response. */
function grokSession(tokens, tokenEndpoint, fallbackRefreshToken) {
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new Error("grok token endpoint returned no access token");
	const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;
	if (refreshToken === void 0) throw new Error("grok token endpoint returned no refresh token");
	if (typeof tokens.expires_in !== "number" || tokens.expires_in <= 0) throw new Error("grok token endpoint returned no usable expiry");
	const account = grokAccount(tokens.id_token);
	return {
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt: Date.now() + tokens.expires_in * 1e3,
		tokenEndpoint,
		...typeof tokens.scope === "string" ? { scopes: tokens.scope } : {},
		...account === void 0 ? {} : { account }
	};
}
/**
* Exchange an authorization code for a grok session (form-encoded grant that
* echoes the PKCE challenge as well as the verifier, per the xAI flow).
* A 403 here means the X plan lacks the API OAuth entitlement.
* @param code - the authorization code from the callback.
* @param verifier - the PKCE verifier minted for the attempt.
* @param redirectUri - the attempt's redirect URI.
* @param challenge - the PKCE challenge sent at authorize time.
* @returns the session to store.
*/
async function exchangeGrokCode(code, verifier, redirectUri, challenge, signal) {
	const discovery = await grokDiscovery(signal);
	const response = await fetch(discovery.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: GROK_CLIENT_ID,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
			code_challenge: challenge,
			code_challenge_method: "S256"
		}).toString(), signal
	});
	if (response.status === 403) throw new OAuthEndpointError("grok token endpoint refused the exchange (HTTP 403): your X plan does not include the API OAuth entitlement; an X Premium or xAI subscription with API access is required", 403);
	if (!response.ok) throw await oauthEndpointError(response, "grok");
	return grokSession(await response.json(), discovery.tokenEndpoint);
}
/**
* Refresh a grok session (form-encoded grant).
* @param session - the stored session.
* @returns the fresh session to store.
*/
async function refreshGrok(session) {
	const response = await fetch(session.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: GROK_CLIENT_ID,
			refresh_token: session.refreshToken
		}).toString()
	});
	if (!response.ok) throw await oauthEndpointError(response, "grok");
	const next = grokSession(await response.json(), session.tokenEndpoint, session.refreshToken);
	return {
		...next,
		...session.account === void 0 ? {} : { account: session.account },
		...next.scopes === void 0 && session.scopes !== void 0 ? { scopes: session.scopes } : {}
	};
}
/**
* Whether a grok refresh failure means the login is permanently gone.
* @param error - the thrown refresh error.
* @returns true when re-login is the only fix.
*/
function isGrokPermanentRefreshError(error) {
	return error instanceof OAuthEndpointError && error.oauthCode === "invalid_grant";
}
/**
* The Grok Build CLI chat proxy's billing endpoint (the source of the CLI's
* `/usage` "Usage limit" panel; see xai-org/grok-build
* `extensions/billing.rs`). Forwards to the backend `GetGrokCreditsConfig`.
*/
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** RFC3339 timestamp â†’ epoch ms, or undefined when absent/unparsable. */
function grokResetsAt(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* Fetch the grok subscription usage from the Grok Build CLI chat proxy. The
* newer credits config carries a ready-made percentage plus the current
* (typically weekly) period; the legacy shape carries cent-valued
* `monthlyLimit`/`used`, from which the percentage is derived.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param signal - caller cancellation from the RPC transport.
* @returns the mapped usage snapshot.
*/
async function fetchGrokUsage(session, fetchFn = fetch, signal) {
	const response = await fetchFn(GROK_BILLING_URL, {
		headers: {
			"authorization": `Bearer ${session.accessToken}`,
			"x-xai-token-auth": "xai-grok-cli",
			"accept": "application/json",
			...attributionHeaders()
		},
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw await oauthEndpointError(response, "grok billing");
	const payload = await response.json();
	const config = typeof payload.config === "object" && payload.config !== null ? payload.config : {};
	const windows = [];
	if (typeof config.creditUsagePercent === "number" && Number.isFinite(config.creditUsagePercent)) {
		const kind = config.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly" : "other";
		const resetsAt = grokResetsAt(config.currentPeriod?.end);
		windows.push({
			kind,
			usedPercent: config.creditUsagePercent,
			...resetsAt === void 0 ? {} : { resetsAt }
		});
	} else if (typeof config.monthlyLimit?.val === "number" && config.monthlyLimit.val > 0 && typeof config.used?.val === 'number' && Number.isFinite(config.used.val)) {
		const used = config.used.val;
		const resetsAt = grokResetsAt(config.billingPeriodEnd);
		windows.push({
			kind: "other",
			usedPercent: used / config.monthlyLimit.val * 100,
			...resetsAt === void 0 ? {} : { resetsAt }
		});
	}
	const plan = typeof payload.subscriptionTier === "string" && payload.subscriptionTier.length > 0 ? payload.subscriptionTier : grokTierName(session.accessToken);
	return {
		supported: true,
		windows,
		...plan === void 0 ? {} : { plan }
	};
}
const GROK_MODELS_URL = "https://api.x.ai/v1/models";
/**
* Input modalities for one grok model: chat models (grok-4 family) accept
* images; code and embedding models are text-only.
*/
function grokModalities(id) {
	return /code|embed/i.test(id) ? ["text"] : ["text", "image"];
}
/**
* The Grok Build CLI chat proxy's model catalog â€” the only grok endpoint that
* advertises reasoning capability. The `api.x.ai/v1/models` and
* `/v1/language-models` payloads carry pricing, context, and aliases only, so
* effort metadata must come from here (the same source the official CLI's
* picker uses).
*/
const GROK_CLI_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
/** Map one CLI catalog entry's reasoning fields, or undefined when unsupported. */
function grokCliReasoning(entry) {
	if (entry.supports_reasoning_effort !== true) return void 0;
	const efforts = (entry.reasoning_efforts ?? []).filter((level) => typeof level.value === "string" && level.value.length > 0).map((level) => ({
		id: ReasoningEffortId(level.value),
		name: typeof level.label === "string" && level.label.length > 0 ? level.label : level.value,
		...typeof level.description === "string" && level.description.length > 0 ? { description: level.description } : {}
	}));
	if (efforts.length === 0) return void 0;
	const defaultEffort = typeof entry.reasoning_effort === "string" && efforts.some((effort) => effort.id === ReasoningEffortId(entry.reasoning_effort)) ? ReasoningEffortId(entry.reasoning_effort) : void 0;
	return {
		efforts,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
/**
* Fetch the CLI catalog and index its per-model metadata by model id.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @returns model id â†’ contributed metadata.
*/
async function fetchGrokCliCatalog(session, fetchFn = fetch) {
	const response = await fetchFn(GROK_CLI_MODELS_URL, { headers: {
		"authorization": `Bearer ${session.accessToken}`,
		"x-xai-token-auth": "xai-grok-cli",
		"accept": "application/json",
		...attributionHeaders()
	} });
	if (!response.ok) throw await oauthEndpointError(response, "grok CLI catalog");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("grok CLI catalog returned no data array");
	const catalog = /* @__PURE__ */ new Map();
	for (const entry of payload.data) {
		if (typeof entry.id !== "string" || entry.id.length === 0) continue;
		const reasoning = grokCliReasoning(entry);
		catalog.set(entry.id, {
			...typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {},
			...typeof entry.description === "string" && entry.description.length > 0 ? { description: entry.description } : {},
			...typeof entry.context_window === "number" && entry.context_window > 0 ? { contextWindow: entry.context_window } : {},
			...reasoning === void 0 ? {} : { reasoning }
		});
	}
	return catalog;
}
/**
* The /v1/models list also serves generation models that cannot chat
* (grok-imagine-image*, grok-imagine-video*) and embedding models; the picker
* must not offer them. Heuristic over the id substring, verified against the
* live catalog (grok-build-0.1 and the grok-4 family pass).
*/
function isChatModel(id) {
	return !/imagine|image-|video|embed/i.test(id);
}
/**
* Fetch the live grok model list, enriched with the CLI catalog's per-model
* metadata (display name, context window, reasoning efforts). The api.x.ai
* list stays authoritative for which models exist; the CLI catalog is
* enrichment only, so its failure degrades to a plain list instead of taking
* discovery down â€” models it does not cover simply expose no efforts.
* @param session - the stored session (used as-is; never refreshed here).
* @param fetchFn - fetch implementation (injectable for tests).
* @param onWarn - warning sink for a failed CLI catalog fetch.
* @returns discovered chat models in endpoint order.
*/
async function fetchGrokModels(session, fetchFn = fetch, onWarn) {
	const [response, cliCatalog] = await Promise.all([fetchFn(GROK_MODELS_URL, { headers: {
		"authorization": `Bearer ${session.accessToken}`,
		"accept": "application/json",
		...attributionHeaders()
	} }), fetchGrokCliCatalog(session, fetchFn).catch((error) => {
		onWarn?.(`grok CLI catalog fetch failed; reasoning efforts are unavailable (${errorChain(error)})`);
	})]);
	if (!response.ok) throw await oauthEndpointError(response, "grok models");
	const payload = await response.json();
	if (!Array.isArray(payload.data)) throw new Error("grok models endpoint returned no data array");
	const seen = /* @__PURE__ */ new Set();
	const discovered = [];
	for (const entry of payload.data) {
		if (typeof entry.id !== "string" || entry.id.length === 0 || seen.has(entry.id)) continue;
		if (!isChatModel(entry.id)) continue;
		seen.add(entry.id);
		discovered.push({
			id: entry.id,
			name: entry.id,
			...cliCatalog?.get(entry.id)
		});
	}
	if (discovered.length === 0) throw new Error("grok models endpoint returned an empty catalog");
	return discovered;
}
/** Grok wire adapter: one instance serves the `grok` provider route. */
var GrokAdapter = class extends LlmAdapter {
	catalog;
	constructor(options) {
		super();
		this.options = options;
		this.catalog = new ModelCatalogCache(options.catalogStore);
	}
	/** Discovery fetcher: resolves the session through the refresh-aware path. */
	async fetchCatalog() {
		return fetchGrokModels(await this.options.tokens.session(), this.options.fetchFn, this.options.onWarn);
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Grok (Subscription)"
		};
	}
	staticModels(provider) {
		return this.options.models.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			inputModalities: model.inputModalities ?? grokModalities(model.id)
		}));
	}
	async listModels(provider) {
		if (await this.options.tokens.peek() === void 0) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		try {
			return (await this.catalog.get(() => this.fetchCatalog())).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				...model.description === void 0 ? {} : { description: model.description },
				inputModalities: grokModalities(model.id)
			}));
		} catch (error) {
			if (error instanceof LlmError && (error.code === "MISSING_CREDENTIAL" || error.code === "INVALID_CREDENTIAL")) return [];
			if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate();
			this.options.onWarn?.(`grok model discovery failed; using the built-in catalog (${errorChain(error)})`);
			return this.staticModels(provider);
		}
	}
	/**
	* The discovered entry for one model. Resolved through the cache's
	* stale-while-revalidate path: capability metadata must stay stable across
	* a long conversation â€” a session that selected a reasoning effort calls
	* this on EVERY step, and forgetting the efforts just because the TTL
	* lapsed mid-turn would fail the call with UNSUPPORTED_REASONING_EFFORT
	* before provider I/O.
	*/
	async discovered(model) {
		if (!this.options.discovery) return void 0;
		return (await this.catalog.resolve(() => this.fetchCatalog()))?.find((entry) => entry.id === model);
	}
	async resolveModel(provider, model) {
		const discovered = await this.discovered(model);
		const configured = this.options.models.find((entry) => entry.id === model);
		return {
			provider,
			id: model,
			name: discovered?.name ?? configured?.name ?? model,
			...discovered?.description === void 0 ? {} : { description: discovered.description },
			inputModalities: configured?.inputModalities ?? grokModalities(model),
			context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? GROK_CONTEXT_WINDOW },
			defaultMaxTokens: configured?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
			...discovered?.reasoning === void 0 ? {} : { reasoning: discovered.reasoning }
		};
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			let session = await this.options.tokens.session();
			let response;
			try {
				response = await this.request(options, session, watchdog.signal);
			} catch (first) {
				if (!isDeadProxyError(first)) throw first;
				response = await this.requestDirect(options, session, watchdog.signal);
			}
			if (response.status === 413) {
				response = await this.request(options, session, watchdog.signal, "aggressive");
				if (response.status === 413) response = await this.request(options, session, watchdog.signal, "minimal");
			}
			if (response.status === 401) {
				session = await this.options.tokens.session(true);
				response = await this.request(options, session, watchdog.signal);
				if (response.status === 413) {
					response = await this.request(options, session, watchdog.signal, "aggressive");
					if (response.status === 413) response = await this.request(options, session, watchdog.signal, "minimal");
				}
			}
			if (!response.ok) throw await httpLlmError(response, "grok API");
			if (response.body === null) throw new LlmError("grok API returned no response body", EMPTY_RESPONSE_CODE);
			yield* streamResponses(response.body, () => {
				watchdog.pulse();
			});
		} catch (error) {
			throw mapFetchFailure("grok API", error, watchdog, options.signal);
		} finally {
			watchdog.stop();
		}
	}
	async requestDirect(options, session, signal, compactLevel) {
		return this.requestWithFetch(options, session, signal, compactLevel, fetchDirect);
	}
	async request(options, session, signal, compactLevel) {
		return this.requestWithFetch(options, session, signal, compactLevel, fetch);
	}
	async requestWithFetch(options, session, signal, compactLevel, fetchFn) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const body = buildGrokBody(options, messages, compactLevel);
		return fetchFn(GROK_API_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"accept": "text/event-stream",
				"content-type": "application/json",
				...attributionHeaders()
			},
			body: JSON.stringify(body),
			signal
		});
	}
};

//#endregion



//#region src/providers/antigravity.ts
/** Google Antigravity subscription provider: OAuth against the public
 * Antigravity desktop client, streaming against the Cloud Code Code Assist
 * `v1internal:streamGenerateContent` backend (the same reachable by `agy`).
 * Requires a Google One AI Premium / Antigravity subscription. */
/** Public client credentials extracted from the Antigravity desktop app;
 * override with ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET env vars. */
const ANTIGRAVITY_PUBLIC_CLIENT_ID =
	"1071006060591-" + "tmhssin2h21lcre235vtolojh4g403ep." + "apps.googleusercontent.com";
const ANTIGRAVITY_PUBLIC_CLIENT_SECRET = "GOCSPX-" + "K58FWR486LdL" + "J1mLB8sXC4z6qDAf";
/** Client ID for Antigravity's Google OAuth app; env var override supported. */
function antigravityClientId() {
	return process.env.ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_PUBLIC_CLIENT_ID;
}
/** Client secret for Antigravity's Google OAuth app; env var override supported. */
function antigravityClientSecret() {
	return process.env.ANTIGRAVITY_CLIENT_SECRET || ANTIGRAVITY_PUBLIC_CLIENT_SECRET;
}
const ANTIGRAVITY_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** The public Antigravity redirect URI; the loopback callback must bind this exact port. */
const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_CALLBACK_PATH = "/oauth-callback";
const ANTIGRAVITY_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs"
].join(" ");
// Match the standalone Antigravity IDE: production Cloud Code for account
// discovery, non-sandbox daily for catalog/generation, then production fallback.
const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINT_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_USAGE_URL = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:retrieveUserQuotaSummary`;
/**
 * Fetch Antigravity subscription usage via the official quota-summary endpoint.
 * Returns { supported: false } when the endpoint is unreachable or the token
 * lacks quota data — degradation is silent so login is never blocked.
 */
async function fetchAntigravityUsage(session, fetchFn = fetch, signal) {
	try {
		const response = await fetchFn(ANTIGRAVITY_USAGE_URL, {
			method: "POST",
			headers: {
				"authorization": `Bearer ${session.accessToken}`,
				"content-type": "application/json",
				...antigravityHeaders()
			},
			body: JSON.stringify({}),
			...signal === void 0 ? {} : { signal }
		});
		if (!response.ok) return { supported: false };
		const payload = await response.json();
		const windows = [];
		if (Array.isArray(payload.groups)) {
			for (const group of payload.groups) {
				for (const bucket of group.buckets || []) {
					if (typeof bucket.remainingFraction !== 'number') continue;
					const kind = (bucket.window || '').toLowerCase().includes('5h') ? 'session' : 'weekly';
					const resetsAt = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : void 0;
					windows.push({ kind, usedPercent: (1 - bucket.remainingFraction) * 100, ...resetsAt ? { resetsAt } : {} });
				}
			}
		}
		return { supported: windows.length > 0, windows };
	} catch { return { supported: false }; }
}

const ANTIGRAVITY_DISCOVERY_ENDPOINTS = [
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_ENDPOINT_SANDBOX
];
const ANTIGRAVITY_GENERATION_ENDPOINTS = [
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_ENDPOINT_SANDBOX
];
// Google rejects newer catalog entries for clients older than 2.9.x.
const ANTIGRAVITY_VERSION = "2.9.1";
const ANTIGRAVITY_PREEMPT_MS = 5 * 6e4;
const ANTIGRAVITY_CONTEXT_WINDOW = 1_048_576;
const ANTIGRAVITY_DEFAULT_MAX_TOKENS = 8192;
const ANTIGRAVITY_MODALITIES = ["text", "image"];
const ANTIGRAVITY_PERMANENT_REFRESH_CODES = new Set([
	"invalid_grant",
	"invalid_client",
	"unauthorized_client"
]);
const antigravityFlow = {
	callbackPath: ANTIGRAVITY_CALLBACK_PATH,
	listen: { host: "localhost", ports: [51121] },
	buildAuthorizeUrl({ state, pkce }) {
		return `${ANTIGRAVITY_AUTHORIZE_URL}?${new URLSearchParams({
			client_id: antigravityClientId(),
			response_type: "code",
			redirect_uri: ANTIGRAVITY_REDIRECT_URI,
			scope: ANTIGRAVITY_SCOPES,
			code_challenge: pkce.challenge,
			code_challenge_method: "S256",
			state,
			access_type: "offline",
			prompt: "consent"
		}).toString()}`;
	}
};
function antigravityPlatform() {
	return typeof process === "object" && process !== null && process.platform === "win32" ? "WINDOWS" : "MACOS";
}
function antigravityPlatformEnum() {
	if (typeof process !== "object" || process === null) return 0;
	if (process.platform === "win32") return 5;
	if (process.platform === "darwin") return process.arch === "arm64" ? 2 : 1;
	if (process.platform === "linux") return process.arch === "arm64" ? 4 : 3;
	return 0;
}
const ANTIGRAVITY_CLIENT_METADATA = {
	ideType: 9,
	platform: antigravityPlatformEnum(),
	pluginType: 2
};
function antigravityHeaders() {
	return {
		"User-Agent": `antigravity/${ANTIGRAVITY_VERSION} ${process.platform === "win32" ? "windows" : process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`,
		"X-Client-Name": "antigravity",
		"X-Client-Version": ANTIGRAVITY_VERSION,
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: antigravityPlatform(), pluginType: "GEMINI" })
	};
}
function antigravitySession(tokens, fallback) {
	if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) throw new Error("antigravity token endpoint returned no access token");
	const refreshToken = tokens.refresh_token ?? fallback?.refreshToken;
	if (refreshToken === void 0) throw new Error("antigravity token endpoint returned no refresh token");
	let expiresAt;
	if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) expiresAt = Date.now() + tokens.expires_in * 1000;
	else {
		const exp = decodeJwtPayload(tokens.access_token)?.exp;
		if (typeof exp === "number" && exp > 0) expiresAt = exp * 1000;
	}
	if (expiresAt === void 0) throw new Error("antigravity token endpoint returned no usable expiry");
	const idToken = tokens.id_token ?? fallback?.idToken;
	let emailAddress = fallback?.emailAddress;
	if (emailAddress === void 0 && typeof tokens.access_token === "string") {
		const email = decodeJwtPayload(tokens.access_token)?.email;
		if (typeof email === "string" && email.length > 0) emailAddress = email;
	}
	const projectsByEndpoint = fallback?.projectsByEndpoint !== void 0 && typeof fallback.projectsByEndpoint === "object" && fallback.projectsByEndpoint !== null
		? { ...fallback.projectsByEndpoint }
		: {};
	return {
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt,
		...idToken === void 0 ? {} : { idToken },
		...emailAddress === void 0 ? {} : { emailAddress },
		...fallback?.projectId === void 0 ? {} : { projectId: fallback.projectId },
		...Object.keys(projectsByEndpoint).length === 0 ? {} : { projectsByEndpoint }
	};
}
function antigravityCompanionProject(value) {
	if (typeof value === "string" && value.length > 0) return value;
	if (value !== null && typeof value === "object" && typeof value.id === "string" && value.id.length > 0) return value.id;
	return void 0;
}
async function antigravityJsonPost(endpoint, method, accessToken, body, fetchFn, signal) {
	const response = await fetchFn(`${endpoint}/v1internal:${method}`, {
		method: "POST",
		headers: { ...antigravityHeaders(), Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify(body), signal
	});
	let data;
	try { data = await response.json(); }
	catch { data = {}; }
	return { response, data };
}
function delayWithSignal(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason ?? new Error("login cancelled"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal.reason ?? new Error("login cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
async function antigravityOnboardProject(endpoint, accessToken, fetchFn, loadData, signal) {
	const allowed = Array.isArray(loadData?.allowedTiers) ? loadData.allowedTiers : [];
	const defaultTier = allowed.find((tier) => tier?.isDefault === true) ?? allowed[0];
	const tierId = typeof defaultTier?.id === "string" && defaultTier.id.length > 0
		? defaultTier.id
		: typeof defaultTier?.tierId === "string" && defaultTier.tierId.length > 0
			? defaultTier.tierId
			: "free-tier";
	for (let attempt = 0; attempt < 6; attempt++) {
		signal?.throwIfAborted();
		const { response, data } = await antigravityJsonPost(endpoint, "onboardUser", accessToken, {
			tierId,
			metadata: ANTIGRAVITY_CLIENT_METADATA
		}, fetchFn, signal);
		if (!response.ok) return void 0;
		const done = data?.done === true || data?.response !== void 0;
		const project = antigravityCompanionProject(data?.response?.cloudaicompanionProject ?? data?.cloudaicompanionProject);
		if (project !== void 0) return project;
		if (done) return void 0;
		await delayWithSignal(2000, signal);
	}
	return void 0;
}
async function antigravityDiscoverProjects(accessToken, fetchFn, signal) {
	const projectsByEndpoint = {};
	let primary;
	for (const endpoint of ANTIGRAVITY_DISCOVERY_ENDPOINTS) {
		signal?.throwIfAborted();
		try {
			const { response, data } = await antigravityJsonPost(endpoint, "loadCodeAssist", accessToken, {
				metadata: ANTIGRAVITY_CLIENT_METADATA,
				mode: 1
			}, fetchFn, signal);
			if (!response.ok) continue;
			let project = antigravityCompanionProject(data.cloudaicompanionProject);
			if (project === void 0) project = await antigravityOnboardProject(endpoint, accessToken, fetchFn, data, signal);
			if (project === void 0) continue;
			projectsByEndpoint[endpoint] = project;
			if (primary === void 0) primary = project;
		} catch (error) {
			if (signal?.aborted) throw error;
			/* try next endpoint */
		}
	}
	return { projectId: primary, projectsByEndpoint };
}
async function exchangeAntigravityCode(code, verifier, signal) {
	const tokens = await fetch(ANTIGRAVITY_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "*/*", "User-Agent": "google-api-nodejs-client/9.15.1" },
		body: new URLSearchParams({
			client_id: antigravityClientId(),
			client_secret: antigravityClientSecret(),
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: ANTIGRAVITY_REDIRECT_URI
		}).toString(), signal
	});
	if (!tokens.ok) throw await oauthEndpointError(tokens, "antigravity");
	const sessionData = antigravitySession(await tokens.json(), void 0);
	const discovered = await antigravityDiscoverProjects(sessionData.accessToken, fetch, signal);
	return {
		...sessionData,
		...discovered.projectId === void 0 ? {} : { projectId: discovered.projectId },
		...Object.keys(discovered.projectsByEndpoint).length === 0 ? {} : { projectsByEndpoint: discovered.projectsByEndpoint }
	};
}
async function refreshAntigravity(session) {
	const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: antigravityClientId(),
			client_secret: antigravityClientSecret(),
			refresh_token: session.refreshToken
		}).toString()
	});
	if (!response.ok) throw await oauthEndpointError(response, "antigravity");
	return antigravitySession(await response.json(), session);
}
function isAntigravityPermanentRefreshError(error) {
	if (!(error instanceof OAuthEndpointError)) return false;
	return ANTIGRAVITY_PERMANENT_REFRESH_CODES.has(error.oauthCode);
}
const callNames = new Map([
	["search_x", "x_search"], ["generate_image", "image_generate"],
	["generate_video", "video_generate"], ["read_file", "read_file"],
	["write_file", "write_file"], ["edit_file", "edit_file"],
	["list_directory", "list_directory"], ["run_command", "run_command"]
]);
function antigravityToolArguments(arguments$1) {
	if (typeof arguments$1 === "string") return arguments$1;
	if (arguments$1 === void 0 || arguments$1 === null) return "{}";
	return JSON.stringify(arguments$1);
}
function antigravityToolName(name) {
	if (typeof name !== "string" || name.length === 0) return "tool";
	return callNames.get(name) ?? name;
}
function antigravityToolDeclaration(tool) {
	const fn = tool?.function ?? tool;
	const name = typeof fn?.name === "string" ? fn.name : "";
	if (name.length === 0) return void 0;
	return {
		name,
		...typeof fn.description === "string" ? { description: fn.description } : {},
		...fn.parameters !== void 0 ? { parameters: fn.parameters } : {}
	};
}
function parseAntigravityToolArgs(value) {
	if (typeof value === "object" && value !== null) return value;
	if (typeof value !== "string" || value.length === 0) return {};
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
	} catch {
		return { value };
	}
}
function antigravityThoughtSignature(part) {
	if (typeof part?.thoughtSignature === "string" && part.thoughtSignature.length > 0) return part.thoughtSignature;
	if (typeof part?.thought_signature === "string" && part.thought_signature.length > 0) return part.thought_signature;
	if (typeof part?.signature === "string" && part.signature.length > 0) return part.signature;
	return void 0;
}
function withThoughtSignature(mapped, part, fallbackSignature) {
	const signature = antigravityThoughtSignature(part) ?? (typeof fallbackSignature === "string" && fallbackSignature.length > 0 ? fallbackSignature : void 0);
	return signature === void 0 ? mapped : { ...mapped, thoughtSignature: signature };
}
function antigravityContentPart(part, callNamesById, sessionId) {
	if (part?.type === "text") return { text: part.text };
	if (part?.type === "reasoning" && typeof part.text === "string" && part.text.length > 0) {
		return withThoughtSignature({ text: part.text, thought: true }, part);
	}
	if (part?.type === "image" && typeof part.dataBase64 === "string" && part.dataBase64.length > 0) {
		return { inlineData: { mimeType: typeof part.mediaType === "string" && part.mediaType.length > 0 ? part.mediaType : "image/png", data: part.dataBase64 } };
	}
	if (part?.type === "tool-call") {
		const name = antigravityToolName(part.name);
		if (typeof part.id === "string" && part.id.length > 0) callNamesById.set(part.id, name);
		const remembered = antigravitySignatureKey(sessionId, part.id);
		const stored = remembered === void 0 ? void 0 : antigravityThoughtSignatures.get(remembered);
		const mapped = withThoughtSignature({ functionCall: { name, args: parseAntigravityToolArgs(part.arguments) } }, part, stored);
		if (mapped.functionCall !== void 0 && mapped.thoughtSignature === void 0) mapped.thoughtSignature = ANTIGRAVITY_DUMMY_THOUGHT_SIGNATURE;
		return mapped;
	}
	if (part?.type === "tool-result") {
		const remembered = typeof part.toolCallId === "string" ? callNamesById.get(part.toolCallId) : void 0;
		return { functionResponse: { name: antigravityToolName(remembered ?? part.name), response: toolResultValue(part) } };
	}
	if (part?.type === "function_call" && part.functionCall !== void 0) return { functionCall: part.functionCall };
	if (part?.type === "function_response") return { functionResponse: { name: antigravityToolName(part.name), response: toolResultValue(part) } };
	if (part?.type === "executable_code") return { executableCode: part.executableCode };
	if (part?.type === "code_execution_result") return { codeExecutionResult: part.codeExecutionResult };
	return void 0;
}
function antigravitySystemParts(content) {
	if (typeof content === "string") return content.length > 0 ? [{ text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts = [];
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) parts.push({ text: part.text });
	}
	return parts;
}
function antigravityGeminiRequest(options, messages) {
	const system = messages.find((m) => m.role === "system");
	const contents = [];
	const callNamesById = new Map();
	for (const msg of messages) {
		if (msg.role === "system") continue;
		const parts = [];
		if (typeof msg.content === "string") {
			if (msg.content.length > 0) parts.push({ text: msg.content });
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				const mapped = antigravityContentPart(part, callNamesById, options.sessionId);
				if (mapped !== void 0) parts.push(mapped);
			}
		}
		if (parts.length === 0) continue;
		const last = contents[contents.length - 1];
		const role = msg.role === "assistant" || msg.role === "model" ? "model" : "user";
		if (last !== void 0 && last.role === role) last.parts.push(...parts);
		else contents.push({ role, parts });
	}
	const declarations = (options.tools ?? []).map(antigravityToolDeclaration).filter((entry) => entry !== void 0);
	const systemParts = system === void 0 ? [] : antigravitySystemParts(system.content);
	const generationConfig = {};
	if (typeof options.maxTokens === "number" && Number.isFinite(options.maxTokens) && options.maxTokens > 0) generationConfig.maxOutputTokens = Math.floor(options.maxTokens);
	if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) generationConfig.temperature = options.temperature;
	const request = {
		contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "Continue." }] }],
		...systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {},
		...declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {},
		...Object.keys(generationConfig).length > 0 ? { generationConfig } : {},
		...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) }
	};
	return request;
}
function toolResultValue(block) {
	if (Array.isArray(block.content)) {
		const texts = [];
		for (const part of block.content) if (part.type === "text") texts.push(part.text);
		return texts.length === 1 ? { result: texts[0] } : { result: texts.join("\n") };
	}
	return { result: String(block.content) };
}
class AntigravityStreamTranslator {
	chunks = [];
	blockIndex = 0;
	sawToolCall = false;
	open = new Map();
	sessionId;
	constructor(sessionId) {
		this.sessionId = sessionId;
	}
	ensure(kind) {
		let block = this.open.get(kind);
		if (block !== void 0) return block;
		const index = this.blockIndex++;
		block = { index, kind, text: "", callId: "", name: "", args: "", thoughtSignature: void 0 };
		this.open.set(kind, block);
		this.chunks.push({ type: "block-start", index, blockType: kind });
		return block;
	}
	close(kind) {
		const block = this.open.get(kind);
		if (block === void 0) return;
		this.open.delete(kind);
		let assembled;
		if (kind === "tool-call") {
			const callId = block.callId.length > 0 ? block.callId : `call_${block.index}`;
			rememberAntigravityThoughtSignature(this.sessionId, callId, block.thoughtSignature);
			assembled = {
				type: "tool-call",
				id: ToolCallId(callId),
				name: block.name,
				arguments: block.args,
				...block.thoughtSignature === void 0 ? {} : { thoughtSignature: block.thoughtSignature }
			};
		} else if (kind === "reasoning") {
			assembled = {
				type: "reasoning",
				text: block.text,
				...block.thoughtSignature === void 0 ? {} : { thoughtSignature: block.thoughtSignature }
			};
		} else {
			assembled = { type: "text", text: block.text };
		}
		this.chunks.push({ type: "block-end", index: block.index, block: assembled });
	}
	closeOthers(keep) {
		for (const kind of [...this.open.keys()]) if (kind !== keep) this.close(kind);
	}
	captureSignature(block, part, nested) {
		const signature = antigravityThoughtSignature(part) ?? antigravityThoughtSignature(nested);
		if (signature !== void 0) block.thoughtSignature = signature;
	}
	push(chunk) {
		const response = chunk.response;
		if (response === void 0 || typeof response !== "object" || response === null) return;
		if (typeof response.modelVersion === 'string') this.chunks.push({ type: 'response-model', model: response.modelVersion });
		if (response.error !== void 0 && response.error !== null) {
			const message = typeof response.error.message === "string" ? response.error.message : String(response.error);
			throw new LlmError(`antigravity API: ${message}`, "SERVER");
		}
		const usage = response.usageMetadata;
		if (usage !== void 0 && typeof usage === "object" && usage !== null) {
			const prompt = tokenCount(usage.promptTokenCount);
			const candidates = tokenCount(usage.candidatesTokenCount);
			const thoughts = tokenCount(usage.thoughtsTokenCount);
			this.chunks.push({ type: "usage", usage: { inputTokens: prompt, outputTokens: candidates, ...thoughts > 0 ? { reasoningTokens: thoughts } : {} } });
		}
		const candidates$ = response.candidates;
		if (!Array.isArray(candidates$) || candidates$.length === 0) return;
		const candidate = candidates$[0];
		const parts = candidate?.content?.parts;
		if (!Array.isArray(parts)) return;
		for (const part of parts) {
			if (part === void 0 || typeof part !== "object") continue;
			if (typeof part.text === "string" && part.text.length > 0) {
				const kind = part.thought === true ? "reasoning" : "text";
				this.closeOthers(kind);
				const block = this.ensure(kind);
				block.text += part.text;
				this.captureSignature(block, part);
				this.chunks.push({ type: kind === "reasoning" ? "reasoning-delta" : "text-delta", index: block.index, text: part.text });
			}
			if (part.functionCall !== void 0 && part.functionCall !== null) {
				this.sawToolCall = true;
				this.closeOthers("tool-call");
				const fc = part.functionCall;
				const block = this.ensure("tool-call");
				const callId = typeof fc.id === "string" && fc.id.length > 0 ? fc.id : `call_${block.index}`;
				block.callId = callId;
				if (typeof fc.name === "string" && fc.name.length > 0) block.name = fc.name;
				block.args = typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args ?? {});
				this.captureSignature(block, part, fc);
				rememberAntigravityThoughtSignature(this.sessionId, callId, block.thoughtSignature);
				this.chunks.push({ type: "tool-call-delta", index: block.index, id: ToolCallId(callId), ...block.name.length > 0 ? { name: block.name } : {}, argumentsDelta: block.args });
				this.close("tool-call");
			}
		}
	}
	finish() {
		for (const kind of [...this.open.keys()]) this.close(kind);
		this.chunks.push({ type: "finish", reason: { kind: this.sawToolCall ? "tool-calls" : "stop" } });
		return this.chunks;
	}
}
function tokenCount(value) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function antigravityPublicModelId(id) {
	return id === "gemini-pro-agent" ? "gemini-3.1-pro-high" : id;
}
function isAntigravityHiddenModel(id, entry) {
	if (entry?.isInternal === true || entry?.apiProvider === "API_PROVIDER_INTERNAL") return true;
	if (/^(tab_|chat_)/i.test(id)) return true;
	if (/(?:^|[-_])(image|imagine)(?:$|[-_])/i.test(id)) return true;
	return false;
}
function antigravityCatalogEntry(id, entry, priority) {
	const publicId = antigravityPublicModelId(id);
	const name = typeof entry?.displayName === "string" && entry.displayName.length > 0 ? entry.displayName : publicId;
	const contextWindow = typeof entry?.maxTokens === "number" && Number.isInteger(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : ANTIGRAVITY_CONTEXT_WINDOW;
	const maxTokens = typeof entry?.maxOutputTokens === "number" && Number.isInteger(entry.maxOutputTokens) && entry.maxOutputTokens > 0 ? entry.maxOutputTokens : ANTIGRAVITY_DEFAULT_MAX_TOKENS;
	const inputModalities = entry?.supportsImages === true ? ["text", "image"] : ["text"];
	return {
		id: publicId,
		name,
		apiId: id,
		contextWindow,
		maxTokens,
		inputModalities,
		priority
	};
}
function parseAntigravityCatalog(payload) {
	const raw = payload?.models;
	if (raw === void 0 || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("antigravity models endpoint returned no models map");
	const recommended = [];
	for (const group of payload.agentModelSorts ?? []) {
		for (const bucket of group?.groups ?? []) {
			for (const id of bucket?.modelIds ?? []) if (typeof id === "string" && id.length > 0) recommended.push(id);
		}
	}
	const seen = new Set();
	const discovered = [];
	const take = (id, priority) => {
		const entry = raw[id];
		if (entry === void 0 || typeof entry !== "object" || entry === null || isAntigravityHiddenModel(id, entry)) return;
		const model = antigravityCatalogEntry(id, entry, priority);
		if (seen.has(model.id)) return;
		seen.add(model.id);
		discovered.push(model);
	};
	recommended.forEach((id, index) => take(id, index));
	if (discovered.length === 0) {
		for (const [id, entry] of Object.entries(raw)) {
			if (entry?.recommended === true) take(id, discovered.length);
		}
	}
	if (discovered.length === 0) {
		for (const [id, entry] of Object.entries(raw)) take(id, discovered.length);
	}
	if (discovered.length === 0) throw new Error("antigravity models endpoint returned an empty catalog");
	return discovered;
}
async function fetchAntigravityModels(session, fetchFn = fetch) {
	let lastError;
	for (const endpoint of ANTIGRAVITY_GENERATION_ENDPOINTS) {
		try {
			const { response, data } = await antigravityJsonPost(endpoint, "fetchAvailableModels", session.accessToken, {}, fetchFn);
			if (!response.ok) {
				lastError = new Error(`antigravity models endpoint HTTP ${String(response.status)}`);
				continue;
			}
			return parseAntigravityCatalog(data);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("antigravity models endpoint returned no catalog");
}
function antigravityLocationBlocked(body) {
	return /user location is not supported for the api use|not currently available in your location|unsupported_location/i.test(body);
}
function antigravityShouldRetryStatus(status) {
	return status === 404 || status === 408 || status === 429 || status >= 500;
}
class AntigravityAdapter extends LlmAdapter {
	projectsCache;
	constructor(options) { super(); this.options = options; this.catalog = new ModelCatalogCache(options.catalogStore); }
	configuredModels() { return this.options.models ?? ANTIGRAVITY_MODELS; }
	async fetchCatalog() {
		return fetchAntigravityModels(await this.options.tokens.session(), this.options.fetchFn ?? fetch);
	}
	async discovered(model) {
		if (!this.options.discovery) return void 0;
		return (await this.catalog.resolve(() => this.fetchCatalog()))?.find((entry) => entry.id === model);
	}
	async resolveApiModel(model) {
		const discovered = await this.discovered(model);
		if (typeof discovered?.apiId === "string" && discovered.apiId.length > 0) return discovered.apiId;
		const configured = this.configuredModels().find((entry) => entry.id === model);
		return configured?.apiId ?? ANTIGRAVITY_API_MODEL_IDS.get(model) ?? model;
	}
	async projectsFor(session, fetchFn) {
		if (session.projectsByEndpoint !== void 0 && typeof session.projectsByEndpoint === "object" && session.projectsByEndpoint !== null && Object.keys(session.projectsByEndpoint).length > 0) return session.projectsByEndpoint;
		if (this.projectsCache !== void 0) return this.projectsCache;
		const discovered = await antigravityDiscoverProjects(session.accessToken, fetchFn);
		this.projectsCache = discovered.projectsByEndpoint;
		return this.projectsCache;
	}
	projectFor(session, endpoint, projects) {
		return projects[endpoint] ?? (endpoint === ANTIGRAVITY_ENDPOINT_DAILY || endpoint === ANTIGRAVITY_ENDPOINT_SANDBOX ? session.projectId : void 0);
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			let session = await this.options.tokens.session();
			let response;
			try {
				response = await this.request(options, session, watchdog.signal);
			} catch (first) {
				if (!isDeadProxyError(first)) throw first;
				response = await this.requestDirect(options, session, watchdog.signal);
			}
			if (response.status === 401) {
				session = await this.options.tokens.session(true);
				this.projectsCache = void 0;
				this.catalog.invalidate();
				response = await this.request(options, session, watchdog.signal);
				if (response.status === 401) {
					await this.options.tokens.invalidate();
					throw new LlmError("Google Antigravity login was rejected after refresh; log in again via Settings → Subscriptions", "INVALID_CREDENTIAL");
				}
			}
			if (!response.ok) throw await httpLlmError(response, "antigravity API");
			if (response.body === null) throw new LlmError("antigravity API returned no response body", EMPTY_RESPONSE_CODE);
			const translator = new AntigravityStreamTranslator(options.sessionId);
			for await (const sseEvent of parseSse(response.body, () => { watchdog.pulse(); })) {
				let parsed;
				try { parsed = JSON.parse(sseEvent.data); }
				catch { throw new LlmError("antigravity API returned a malformed SSE payload", "MALFORMED_RESPONSE"); }
				translator.push(parsed);
				for (const emitted of translator.chunks) yield emitted;
				translator.chunks = [];
			}
			yield* translator.finish();
		} catch (error) { throw mapFetchFailure("antigravity API", error, watchdog, options.signal); }
		finally { watchdog.stop(); }
	}
	async request(options, session, signal) {
		return this.requestWithFetch(options, session, signal, this.options.fetchFn ?? fetch);
	}
	async requestDirect(options, session, signal) {
		return this.requestWithFetch(options, session, signal, fetchDirect);
	}
	async requestWithFetch(options, session, signal, fetchFn) {
		const resolved = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const request = antigravityGeminiRequest(options, resolved);
		const apiModel = await this.resolveApiModel(options.model);
		const projects = await this.projectsFor(session, fetchFn);
		const endpoints = this.options.endpoint !== void 0 ? [this.options.endpoint] : ANTIGRAVITY_GENERATION_ENDPOINTS;
		let lastResponse;
		for (let index = 0; index < endpoints.length; index++) {
			const endpoint = endpoints[index];
			const projectId = this.projectFor(session, endpoint, projects);
			if (projectId === void 0) continue;
			const response = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
				method: "POST",
				headers: { ...antigravityHeaders(), Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json", Accept: "text/event-stream", requestType: "agent" },
				body: JSON.stringify({
					project: projectId,
					requestId: `agent-${randomUUID()}`,
					model: apiModel,
					userAgent: "antigravity",
					requestType: "agent",
					request
				}),
				signal
			});
			lastResponse = response;
			if (response.ok || response.status === 401) return response;
			const more = index < endpoints.length - 1;
			if (!more) return response;
			if (antigravityShouldRetryStatus(response.status)) {
				try { await response.arrayBuffer(); } catch { /* discard */ }
				continue;
			}
			if (response.status === 400) {
				const body = await response.text();
				if (antigravityLocationBlocked(body)) continue;
				return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
			}
			return response;
		}
		if (lastResponse !== void 0) return lastResponse;
		throw new LlmError("antigravity API: no Cloud Code companion project is available for this Google account", "AUTH");
	}
	providerInfo(provider) { return { id: provider, name: "Google Antigravity" }; }
	staticModels(provider) {
		return this.configuredModels().map((model) => ({ provider, id: model.id, name: model.name ?? model.id, ...model.description === void 0 ? {} : { description: model.description }, inputModalities: model.inputModalities ?? ANTIGRAVITY_MODALITIES }));
	}
	listedModel(provider, model) {
		return { provider, id: model.id, name: model.name ?? model.id, ...model.description === void 0 ? {} : { description: model.description }, inputModalities: model.inputModalities ?? ANTIGRAVITY_MODALITIES };
	}
	async listModels(provider) {
		if (await this.options.tokens.peek() === void 0) return [];
		if (!this.options.discovery) return this.staticModels(provider);
		try {
			return (await this.catalog.get(() => this.fetchCatalog())).map((model) => this.listedModel(provider, model));
		} catch (error) {
			if (error instanceof LlmError && (error.code === "MISSING_CREDENTIAL" || error.code === "INVALID_CREDENTIAL")) return [];
			if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate();
			this.options.onWarn?.(`antigravity model discovery failed; using the built-in catalog (${errorChain(error)})`);
			return this.staticModels(provider);
		}
	}
	async resolveModel(provider, model) {
		const discovered = await this.discovered(model);
		const configured = this.configuredModels().find((entry) => entry.id === model);
		return {
			provider,
			id: model,
			name: discovered?.name ?? configured?.name ?? model,
			...discovered?.description === void 0 ? {} : { description: discovered.description },
			inputModalities: discovered?.inputModalities ?? configured?.inputModalities ?? ANTIGRAVITY_MODALITIES,
			context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? ANTIGRAVITY_CONTEXT_WINDOW },
			defaultMaxTokens: discovered?.maxTokens ?? configured?.maxTokens ?? ANTIGRAVITY_DEFAULT_MAX_TOKENS
		};
	}
}
// Picker ids may differ from Cloud Code wire ids. Keep legacy conversation
// ids mapped so a saved chat cannot keep sending a 404ing alias.
const ANTIGRAVITY_API_MODEL_IDS = new Map([
	["gemini-3.1-pro-high", "gemini-pro-agent"],
	["antigravity-gemini-3-pro", "gemini-pro-agent"],
	["antigravity-gemini-3.1-pro", "gemini-pro-agent"],
	["antigravity-gemini-2.5-pro", "gemini-2.5-pro"],
	["antigravity-gemini-3-flash", "gemini-3-flash"]
]);
const ANTIGRAVITY_MODELS = [
	{ id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", contextWindow: 1_048_576, maxTokens: 65536 },
	{ id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", contextWindow: 1_048_576, maxTokens: 65536 },
	{ id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", contextWindow: 1_048_576, maxTokens: 65536 },
	{ id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", contextWindow: 1_048_576, maxTokens: 65536 },
	{ id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", contextWindow: 1_048_576, maxTokens: 65536 },
	{ id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", contextWindow: 1_048_576, maxTokens: 65536 },
	{ id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", apiId: "gemini-pro-agent", contextWindow: 1_048_576, maxTokens: 65535 },
	{ id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", contextWindow: 1_048_576, maxTokens: 65535 },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", contextWindow: 1_048_576, maxTokens: 65536 },
	{ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", contextWindow: 1_048_576, maxTokens: 65536 },
	{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", contextWindow: 1_048_576, maxTokens: 65536 }
];
//#endregion
//#region src/providers/openrouter.ts
/** OpenRouter subscription provider: OAuth PKCE → user-controlled API key.
 *
 * OpenRouter exposes a public OAuth PKCE flow (no registered client).
 * The user authorises once, and the exchange returns a static API key that
 * is used as a Bearer token against the OpenAI-compatible chat/completions
 * endpoint for the lifetime of that login. There is no refresh token or
 * expiry — the TokenManager is treated as read-only after the initial
 * exchange.
 *
 * Docs: https://openrouter.ai/docs/guides/overview/auth/oauth */
const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_CALLBACK_PATH = "/callback";
const OPENROUTER_CONTEXT_WINDOW = 128e3;
const OPENROUTER_DEFAULT_MAX_TOKENS = 16384;
const OPENROUTER_PREEMPT_MS = 5 * 6e4;
const OPENROUTER_MODALITIES = ["text"];
const OPENROUTER_MODELS = [
	{ id: "openai/gpt-4o", name: "GPT-4o (OpenRouter)", contextWindow: 128e3, maxTokens: 16384 },
	{ id: "openai/gpt-4o-mini", name: "GPT-4o Mini (OpenRouter)", contextWindow: 128e3, maxTokens: 16384 },
	{ id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (OpenRouter)", contextWindow: 200e3, maxTokens: 32768 },
	{ id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (OpenRouter)", contextWindow: 200e3, maxTokens: 32768 },
	{ id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (OpenRouter)", contextWindow: 1e6, maxTokens: 65536 }
];
const openrouterFlow = {
	callbackPath: OPENROUTER_CALLBACK_PATH,
	listen: { host: "localhost", ports: [0] },
	buildAuthorizeUrl({ state, pkce }) {
		const url = new URL(`${OPENROUTER_AUTHORIZE_URL}?`);
		url.searchParams.set("code_challenge", pkce.challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", state);
		url.searchParams.set("callback_url", openrouterFlow.listen.host);
		return url.toString();
	}
};
async function exchangeOpenRouterCode(code, verifier, signal) {
	const response = await fetch(OPENROUTER_KEYS_URL, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }), signal
	});
	if (!response.ok) throw await oauthEndpointError(response, "openrouter");
	const data = await response.json();
	const key = typeof data.key === "string" && data.key.length > 0 ? data.key : void 0;
	if (key === void 0) throw new Error("openrouter exchange returned no API key");
	return { accessToken: key, emailAddress: void 0 };
}
function isPermanentOpenRouterExchangeError(error) {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return msg.includes("invalid code") || msg.includes("expired") || msg.includes("403") || msg.includes("401");
}
class OpenRouterStreamTranslator {
	chunks = []; blockIndex = 0; sawToolCall = false;
	push(event) {
		if (!event?.choices?.length) return;
		const choice = event.choices[0];
		if (choice?.finish_reason) { this.sawToolCall = choice.finish_reason === "tool_calls"; return; }
		const delta = choice.delta;
		if (delta === void 0 || delta === null) return;
		if (typeof delta.content === "string" && delta.content.length > 0) this.chunks.push({ type: "text-delta", index: this.blockIndex, text: delta.content });
		const tcs = delta.tool_calls;
		if (!Array.isArray(tcs)) return;
		for (const tc of tcs) {
			if (tc?.index !== void 0) this.blockIndex = tc.index;
			if (tc?.id !== void 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, id: ToolCallId(tc.id) });
			if (tc?.type !== void 0 && tc.type !== "function") continue;
			const fn = tc.function;
			if (fn === void 0) continue;
			if (typeof fn.name === "string" && fn.name.length > 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, name: fn.name });
			if (typeof fn.arguments === "string" && fn.arguments.length > 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, argumentsDelta: fn.arguments });
		}
	}
	finish() {
		this.chunks.push({ type: "finish", reason: { kind: this.sawToolCall ? "tool-calls" : "stop" } });
		if (this.chunks.length > 0 && this.chunks[this.chunks.length - 1].type !== "usage") this.chunks.push({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } });
		return this.chunks;
	}
}
class OpenRouterAdapter extends LlmAdapter {
	constructor(options) { super(); this.options = options; this.catalog = new ModelCatalogCache(options.catalogStore); }
	providerInfo(provider) { return { id: provider, name: "OpenRouter (Subscription)" }; }
	staticModels(provider) { return (this.options.models ?? OPENROUTER_MODELS).map((m) => ({ provider, id: m.id, name: m.name ?? m.id, inputModalities: m.inputModalities ?? OPENROUTER_MODALITIES })); }
	async listModels(provider) { if (await this.options.tokens.peek() === void 0) return []; return this.staticModels(provider); }
	async resolveModel(provider, model) {
		const configured = (this.options.models ?? OPENROUTER_MODELS).find((m) => m.id === model);
		return { provider, id: model, name: configured?.name ?? model, inputModalities: OPENROUTER_MODALITIES, context: { contextWindow: configured?.contextWindow ?? OPENROUTER_CONTEXT_WINDOW }, defaultMaxTokens: configured?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS };
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			const session = await this.options.tokens.session();
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) {
				await this.options.tokens.invalidate();
				throw new LlmError("openrouter API key invalid; re-login via Settings → Subscriptions", "INVALID_CREDENTIAL");
			}
			if (!response.ok) throw await httpLlmError(response, "openrouter API");
			if (response.body === null) throw new LlmError("openrouter API returned no response body", EMPTY_RESPONSE_CODE);
			const translator = new OpenRouterStreamTranslator();
			for await (const sseEvent of parseSse(response.body, () => { watchdog.pulse(); })) {
				let event;
				try { event = JSON.parse(sseEvent.data); }
				catch { throw new LlmError("openrouter API returned a malformed SSE payload", "MALFORMED_RESPONSE"); }
				translator.push(event);
				for (const emitted of translator.chunks) yield emitted;
				translator.chunks = [];
			}
			yield* translator.finish();
		} catch (error) { throw mapFetchFailure("openrouter API", error, watchdog, options.signal); }
		finally { watchdog.stop(); }
	}
	async request(options, session, signal) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const chatMessages = messages.map((m) => {
			if (m.role === "system") return { role: "system", content: m.content };
			if (m.role === "user" && typeof m.content === "string") return { role: "user", content: m.content };
			if (m.role === "user" && Array.isArray(m.content)) {
				const parts = [];
				for (const c of m.content) { if (c.type === "text") parts.push({ type: "text", text: c.text }); else if (c.type === "image_url") parts.push(c); }
				return { role: "user", content: parts.length === 1 ? parts[0].text : parts };
			}
			if (m.role === "assistant" && typeof m.content === "string") return { role: "assistant", content: m.content };
			return m;
		});
		const body = {
			model: options.model, messages: chatMessages, stream: true,
			...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
			...options.temperature !== void 0 ? { temperature: options.temperature } : {},
			...options.seed !== void 0 ? { seed: options.seed } : {},
			...options.tools !== void 0 && options.tools.length > 0 ? { tools: options.tools.map((t) => ({ type: "function", function: t.function })) } : {}
		};
		return fetch(OPENROUTER_API_URL, {
			method: "POST",
			headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json", accept: "text/event-stream", ...attributionHeaders() },
			body: JSON.stringify(body), signal
		});
	}
}
//#endregion
//#region src/providers/agnes.ts
/** Agnes AI subscription provider: OAuth PKCE → access token.
 *
 * AgnesCode opens the authorization URL in the browser, then the browser
 * tries to open the `agnes://auth/callback` deep link. Since DSH has no
 * protocol handler, the login flow uses manual pasting: the user pastes the
 * full callback URL (or just the authorization code) into the DSH UI and
 * the plugin exchanges it against the Agnes BFF backend.
 *
 * Source: reverse-engineered from AgnesCode v1.0.26 renderer bundle.
 * Docs: https://wiki.agnes-ai.com/en/docs/overview */
const AGNES_CLIENT_ID = "agnes-code";
const AGNES_AUTHORIZE_URL = "https://app.agnes-ai.com/login";
const AGNES_CALLBACK_URI = "agnes://auth/callback";
const AGNES_EXCHANGE_URL = "https://api-agnes-code.agnes-ai.com/api/v1/code/auth/exchange-code";
const AGNES_REFRESH_URL = "https://api-agnes-code.agnes-ai.com/api/v1/user/refresh-token";
const AGNES_API_BASE = "https://api-agnes-code.agnes-ai.com/v1";
const AGNES_CALLBACK_PATH = "/callback";
const AGNES_CONTEXT_WINDOW = 524288;
const AGNES_DEFAULT_MAX_TOKENS = 16384;
const AGNES_PREEMPT_MS = 5 * 6e4;
const AGNES_MODALITIES = ["text", "image"];
const AGNES_MODELS = [
	{ id: "agnes-2.5-flash", name: "Agnes 2.5 Flash", contextWindow: 524288, maxTokens: 16384 },
	{ id: "agnes-2.0-flash", name: "Agnes 2.0 Flash", contextWindow: 262144, maxTokens: 16384 },
	{ id: "openai/gpt-4o", name: "GPT-4o (via Agnes)", contextWindow: 128e3, maxTokens: 16384 },
	{ id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (via Agnes)", contextWindow: 200e3, maxTokens: 32768 }
];
const agnesFlow = {
	callbackPath: AGNES_CALLBACK_PATH,
	listen: { host: "localhost", ports: [0] },
	buildAuthorizeUrl({ state, pkce }) {
		const url = new URL(AGNES_AUTHORIZE_URL);
		url.searchParams.set("client", AGNES_CLIENT_ID);
		url.searchParams.set("redirect_uri", AGNES_CALLBACK_URI);
		url.searchParams.set("state", state);
		return url.toString();
	}
};
function tr(session) {
	if (!session || typeof session !== "object") return false;
	const s = session;
	if (typeof s.accessToken !== "string" || !s.accessToken.trim() || s.accessToken.length > 65536) return false;
	if (!s.userInfo || typeof s.userInfo !== "object" || Array.isArray(s.userInfo)) return false;
	const uid = typeof s.userInfo.id === "string" ? s.userInfo.id : typeof s.userInfo.id === "number" && Number.isFinite(s.userInfo.id) ? String(s.userInfo.id) : null;
	if (typeof uid !== "string" || uid.length === 0) return false;
	if (typeof s.newapiReady !== "boolean" || typeof s.newapiInitialized !== "boolean") return false;
	if (typeof s.bffPublicBaseUrl !== "string") return false;
	try { const u = new URL(s.bffPublicBaseUrl); if (u.protocol !== "https:" && u.protocol !== "http:") return false; if (u.username || u.password) return false; } catch { return false; }
	return true;
}
async function exchangeAgnesCode(code, state, signal) {
	const response = await fetch(AGNES_EXCHANGE_URL, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, redirect_uri: AGNES_CALLBACK_URI, state, client_id: AGNES_CLIENT_ID }), signal
	});
	if (!response.ok) throw await oauthEndpointError(response, "agnes");
	const text = await response.text();
	let data;
	try { data = JSON.parse(text); } catch { throw new Error("agnes exchange returned non-JSON"); }
	const apiCode = data?.code;
	if (apiCode !== 0 && apiCode !== "000000") {
		const safeCode = typeof apiCode === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(apiCode) ? apiCode : "provider_error";
		throw new Error(`Agnes login rejected (HTTP ${response.status}, ${safeCode})`);
	}
	const accessToken = data?.data?.access_token;
	if (!accessToken || typeof accessToken !== "string") throw new Error("agnes exchange returned no access token");
	return { accessToken, userInfo: data?.data?.user_info ?? {}, newapiReady: true, newapiInitialized: true, bffPublicBaseUrl: AGNES_API_BASE };
}
async function refreshAgnes(session) {
	const response = await fetch(AGNES_REFRESH_URL, {
		method: "POST", headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" }
	});
	if (!response.ok) throw await oauthEndpointError(response, "agnes");
	const text = await response.text();
	let data;
	try { data = JSON.parse(text); } catch { throw new Error("agnes refresh returned non-JSON"); }
	const apiCode = data?.code;
	if (apiCode !== 0 && apiCode !== "000000") throw new Error(data?.message ?? `Token refresh failed (HTTP ${response.status})`);
	const newToken = data?.data?.access_token;
	if (!newToken || typeof newToken !== "string") throw new Error("agnes refresh returned no access token");
	return { ...session, accessToken: newToken };
}
function isPermanentAgnesError(error) {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return msg.includes("authentication denied") || msg.includes("login expired") || msg.includes("invalid grant") || msg.includes("401") || msg.includes("403");
}
class AgnesStreamTranslator {
	chunks = []; blockIndex = 0; sawToolCall = false;
	push(event) {
		if (!event?.choices?.length) return;
		const choice = event.choices[0];
		if (choice?.finish_reason) { this.sawToolCall = choice.finish_reason === "tool_calls"; return; }
		const delta = choice.delta;
		if (delta === void 0 || delta === null) return;
		if (typeof delta.content === "string" && delta.content.length > 0) this.chunks.push({ type: "text-delta", index: this.blockIndex, text: delta.content });
		const tcs = delta.tool_calls;
		if (!Array.isArray(tcs)) return;
		for (const tc of tcs) {
			if (tc?.index !== void 0) this.blockIndex = tc.index;
			if (tc?.id !== void 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, id: ToolCallId(tc.id) });
			if (tc?.type !== void 0 && tc.type !== "function") continue;
			const fn = tc.function;
			if (fn === void 0) continue;
			if (typeof fn.name === "string" && fn.name.length > 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, name: fn.name });
			if (typeof fn.arguments === "string" && fn.arguments.length > 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, argumentsDelta: fn.arguments });
		}
	}
	finish() {
		this.chunks.push({ type: "finish", reason: { kind: this.sawToolCall ? "tool-calls" : "stop" } });
		if (this.chunks.length > 0 && this.chunks[this.chunks.length - 1].type !== "usage") this.chunks.push({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } });
		return this.chunks;
	}
}
class AgnesAdapter extends LlmAdapter {
	constructor(options) { super(); this.options = options; this.catalog = new ModelCatalogCache(options.catalogStore); }
	providerInfo(provider) { return { id: provider, name: "Agnes AI (Subscription)" }; }
	staticModels(provider) { return (this.options.models ?? AGNES_MODELS).map((m) => ({ provider, id: m.id, name: m.name ?? m.id, inputModalities: m.inputModalities ?? AGNES_MODALITIES })); }
	async listModels(provider) { if (await this.options.tokens.peek() === void 0) return []; return this.staticModels(provider); }
	async resolveModel(provider, model) {
		const configured = (this.options.models ?? AGNES_MODELS).find((m) => m.id === model);
		return { provider, id: model, name: configured?.name ?? model, inputModalities: AGNES_MODALITIES, context: { contextWindow: configured?.contextWindow ?? AGNES_CONTEXT_WINDOW }, defaultMaxTokens: configured?.maxTokens ?? AGNES_DEFAULT_MAX_TOKENS };
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			const session = await this.options.tokens.session();
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) throw new LlmError("agnes API key invalid; re-login via Settings → Subscriptions", "INVALID_CREDENTIAL");
			if (!response.ok) throw await httpLlmError(response, "agnes API");
			if (response.body === null) throw new LlmError("agnes API returned no response body", EMPTY_RESPONSE_CODE);
			const translator = new AgnesStreamTranslator();
			for await (const sseEvent of parseSse(response.body, () => { watchdog.pulse(); })) {
				let event;
				try { event = JSON.parse(sseEvent.data); }
				catch { throw new LlmError("agnes API returned a malformed SSE payload", "MALFORMED_RESPONSE"); }
				translator.push(event);
				for (const emitted of translator.chunks) yield emitted;
				translator.chunks = [];
			}
			yield* translator.finish();
		} catch (error) { throw mapFetchFailure("agnes API", error, watchdog, options.signal); }
		finally { watchdog.stop(); }
	}
	async request(options, session, signal) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const chatMessages = messages.map((m) => {
			if (m.role === "system") return { role: "system", content: m.content };
			if (m.role === "user" && typeof m.content === "string") return { role: "user", content: m.content };
			if (m.role === "user" && Array.isArray(m.content)) {
				const parts = [];
				for (const c of m.content) { if (c.type === "text") parts.push({ type: "text", text: c.text }); else if (c.type === "image_url") parts.push(c); }
				return { role: "user", content: parts.length === 1 ? parts[0].text : parts };
			}
			if (m.role === "assistant" && typeof m.content === "string") return { role: "assistant", content: m.content };
			return m;
		});
		const body = {
			model: options.model, messages: chatMessages, stream: true,
			...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
			...options.temperature !== void 0 ? { temperature: options.temperature } : {},
			...options.tools !== void 0 && options.tools.length > 0 ? { tools: options.tools.map((t) => ({ type: "function", function: t.function })) } : {}
		};
		return fetch(AGNES_API_BASE + "/chat/completions", {
			method: "POST",
			headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json", accept: "text/event-stream", ...attributionHeaders() },
			body: JSON.stringify(body), signal
		});
	}
}
//#endregion
//#region src/providers/qwen.ts
/** Qwen Code subscription provider: Device-flow OAuth against chat.qwen.ai.
 *
 * Uses the Qwen desktop CLI public client ID extracted from the official
 * Qwen Code Electron app. The flow is RFC 8628 device authorization:
 *   1. Request a device code + user code
 *   2. Open the browser to the verification URL
 *   3. Poll for token until the user approves
 *
 * The stored session carries access_token + refresh_token and is auto-refreshed.
 *
 * Client ID: embedded from Qwen Code desktop app (same as qwen-code).
 * Docs: https://qwen.readthedocs.io/ */
const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_DEVICE_CODE_URL = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const QWEN_TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";
const QWEN_API_URL = "https://qwen-api.alicdn.com/v1/chat/completions";
const QWEN_USERINFO_URL = "https://chat.qwen.ai/api/v1/user/info";
const QWEN_SCOPE = "openid profile email model.completion";
const QWEN_CONTEXT_WINDOW = 131072;
const QWEN_DEFAULT_MAX_TOKENS = 8192;
const QWEN_PREEMPT_MS = 5 * 6e4;
const QWEN_MODALITIES = ["text", "image"];
const QWEN_MODELS = [
	{ id: "qwen-max", name: "Qwen-Max", contextWindow: 131072, maxTokens: 8192 },
	{ id: "qwen-plus", name: "Qwen-Plus", contextWindow: 131072, maxTokens: 8192 },
	{ id: "qwen-turbo", name: "Qwen-Turbo", contextWindow: 131072, maxTokens: 8192 },
	{ id: "qwen-long", name: "Qwen-Long", contextWindow: 1000000, maxTokens: 8192 }
];
function qwenEncodeUrlEncoded(obj) {
	return Object.keys(obj).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])).join("&");
}
async function qwenRequestDeviceAuthorization(pkce, signal) {
	return _startQwenDeviceFlow(pkce, fetch, signal);
}
/**
 * Start a Qwen device-authorization flow. Returns immediately with the
 * verification info; the caller is expected to run the background poll separately.
 */
async function startQwenDeviceFlow(pkce, signal) {
	return _startQwenDeviceFlow(pkce, fetch, signal);
}
/**
 * Run the Qwen device-flow poll to completion: await token, fetch userinfo,
 * persist session, and clear errors. Throws on cancellation or permanent failure.
 * Identity-safe: only deletes the flow if it is still the current one.
 */
async function runQwenDevicePoll(flow, controller) {
	try {
		const tokenData = await _qwenPollDeviceToken(flow.deviceCode, flow.pkce.verifier, {
			signal: flow.signal,
			expiresAt: flow.expiresAt,
			initialIntervalMs: flow.interval,
		});
		if (!tokenData.access_token) throw new Error("qwen token endpoint returned no access_token");
		const userinfo = await fetch(QWEN_USERINFO_URL, {
			headers: { Authorization: "Bearer " + tokenData.access_token },
			signal: flow.signal,
		}).then(r => r.ok ? r.json().catch(() => ({})) : Promise.resolve({})).catch(() => ({}));
		flow.signal.throwIfAborted();
		const session = {
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token,
			expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : flow.expiresAt,
			emailAddress: userinfo?.email || undefined,
		};
		if (typeof session.refreshToken !== "string" || session.refreshToken.length === 0) throw new Error("qwen token endpoint returned no refresh_token");
		await controller.persist("qwen", session, flow.signal);
		controller.lastError.delete("qwen");
		controller.onAuthChanged("qwen");
	}
	catch (error) {
		// Cancellation is expected — do not record as error.
		if (error instanceof Error && error.message === "login cancelled") {
			flow.cancelled = true;
			return;
		}
		if (!controller.disposed && !flow.signal?.aborted) controller.lastError.set("qwen", safeDiagnostic(error));
	}
	finally {
		// Identity-safe cleanup: only delete if this flow is still the current one.
		controller.deviceFlows?.delete("qwen", flow);
		if (!controller.disposed) controller.onAuthChanged("qwen");
	}
}
function isPermanentQwenError(error) {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return msg.includes("invalid_grant") || msg.includes("expired") || msg.includes("401") || msg.includes("403") || msg.includes("unauthorized");
}
class QwenAdapter extends LlmAdapter {
	constructor(options) { super(); this.options = options; this.catalog = new ModelCatalogCache(options.catalogStore); }
	providerInfo(provider) { return { id: provider, name: "Qwen Code (Subscription)" }; }
	staticModels(provider) { return (this.options.models ?? QWEN_MODELS).map((m) => ({ provider, id: m.id, name: m.name ?? m.id, inputModalities: m.inputModalities ?? QWEN_MODALITIES })); }
	async listModels(provider) { if (await this.options.tokens.peek() === void 0) return []; return this.staticModels(provider); }
	async resolveModel(provider, model) {
		const configured = (this.options.models ?? QWEN_MODELS).find((m) => m.id === model);
		return { provider, id: model, name: configured?.name ?? model, inputModalities: QWEN_MODALITIES, context: { contextWindow: configured?.contextWindow ?? QWEN_CONTEXT_WINDOW }, defaultMaxTokens: configured?.maxTokens ?? QWEN_DEFAULT_MAX_TOKENS };
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			const session = await this.options.tokens.session();
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) throw new LlmError("qwen access token invalid; re-login via Settings → Subscriptions", "INVALID_CREDENTIAL");
			if (!response.ok) throw await httpLlmError(response, "qwen API");
			if (response.body === null) throw new LlmError("qwen API returned no response body", EMPTY_RESPONSE_CODE);
			for await (const sseEvent of parseSse(response.body, () => { watchdog.pulse(); })) {
				let event;
				try { event = JSON.parse(sseEvent.data); }
				catch { throw new LlmError("qwen API returned a malformed SSE payload", "MALFORMED_RESPONSE"); }
				if (!event?.choices?.length) continue;
				const choice = event.choices[0];
				const delta = choice?.delta;
				if (delta && typeof delta.content === "string" && delta.content.length > 0) {
					yield { type: "text-delta", index: 0, text: delta.content };
				}
				if (choice.finish_reason === "stop" || choice.finish_reason === "tool_calls") {
					yield { type: "finish", reason: { kind: choice.finish_reason === "tool_calls" ? "tool-calls" : "stop" } };
					yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
				}
			}
		} catch (error) { throw mapFetchFailure("qwen API", error, watchdog, options.signal); }
		finally { watchdog.stop(); }
	}
	async request(options, session, signal) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const chatMessages = messages.map((m) => {
			if (m.role === "system") return { role: "system", content: m.content };
			if (m.role === "user" && typeof m.content === "string") return { role: "user", content: m.content };
			if (m.role === "user" && Array.isArray(m.content)) {
				const parts = [];
				for (const c of m.content) { if (c.type === "text") parts.push({ type: "text", text: c.text }); else if (c.type === "image_url") parts.push(c); }
				return { role: "user", content: parts.length === 1 ? parts[0].text : parts };
			}
			if (m.role === "assistant" && typeof m.content === "string") return { role: "assistant", content: m.content };
			return m;
		});
		const body = {
			model: options.model, messages: chatMessages, stream: true,
			...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
			...options.temperature !== void 0 ? { temperature: options.temperature } : {},
			...options.tools !== void 0 && options.tools.length > 0 ? { tools: options.tools.map((t) => ({ type: "function", function: t.function })) } : {}
		};
		return fetch(QWEN_API_URL, {
			method: "POST",
			headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json", accept: "text/event-stream", ...attributionHeaders() },
			body: JSON.stringify(body), signal
		});
	}
}
//#endregion
async function refreshQwen(session) {
	const body = qwenEncodeUrlEncoded({
		grant_type: "refresh_token",
		refresh_token: session.refreshToken,
		client_id: QWEN_CLIENT_ID,
	});
	const response = await fetch(QWEN_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body,
	});
	if (!response.ok) throw await oauthEndpointError(response, "qwen");
	const data = await response.json();
	return { ...session, accessToken: data.access_token, refreshToken: data.refresh_token ?? session.refreshToken, expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : session.expiresAt };
}
//#region src/providers/spark.ts
/** iFlytek Spark subscription provider: OAuth PKCE → access token.
 *
 * Spark's Open Platform uses standard OAuth2 with PKCE. Users register an app
 * at spark-api.xf-yun.com and provide client_id/client_secret via environment
 * variables. The exchange returns an access token used against the OpenAI-compatible
 * chat completions endpoint.
 *
 * Docs: https://www.xfyun.cn/doc/spark */
const SPARK_CLIENT_ID_ENV = "SPARK_CLIENT_ID";
const SPARK_CLIENT_SECRET_ENV = "SPARK_CLIENT_SECRET";
const SPARK_AUTHORIZE_URL = "https://spark-api.xf-yun.com/oauth/authorize";
const SPARK_TOKEN_URL = "https://spark-api.xf-yun.com/oauth/token";
const SPARK_API_URL = "https://spark-api.xf-yun.com/v1/chat/completions";
const SPARK_CALLBACK_PATH = "/callback";
const SPARK_CONTEXT_WINDOW = 16384;
const SPARK_DEFAULT_MAX_TOKENS = 4096;
const SPARK_PREEMPT_MS = 5 * 6e4;
const SPARK_MODALITIES = ["text"];
const SPARK_MODELS = [
	{ id: "spark-4.0", name: "Spark 4.0", contextWindow: 16384, maxTokens: 4096 },
	{ id: "spark-3.5-max", name: "Spark 3.5 Max", contextWindow: 16384, maxTokens: 4096 },
	{ id: "spark-lite", name: "Spark Lite", contextWindow: 8192, maxTokens: 2048 }
];
function sparkClientId() { return process.env[SPARK_CLIENT_ID_ENV] ?? ""; }
function sparkClientSecret() { return process.env[SPARK_CLIENT_SECRET_ENV] ?? ""; }
const sparkFlow = {
	callbackPath: SPARK_CALLBACK_PATH,
	listen: { host: "localhost", ports: [0] },
	buildAuthorizeUrl({ state, pkce }) {
		const url = new URL(SPARK_AUTHORIZE_URL);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", sparkClientId());
		url.searchParams.set("redirect_uri", sparkFlow.listen.host + SPARK_CALLBACK_PATH);
		url.searchParams.set("code_challenge", pkce.challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", state);
		return url.toString();
	}
};
async function exchangeSparkCode(code, verifier, signal) {
	const response = await fetch(SPARK_TOKEN_URL, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			redirect_uri: sparkFlow.listen.host + SPARK_CALLBACK_PATH,
			client_id: sparkClientId(),
			client_secret: sparkClientSecret(),
			code_verifier: verifier
		}), signal
	});
	if (!response.ok) throw await oauthEndpointError(response, "spark");
	const data = await response.json();
	const token = typeof data.access_token === "string" ? data.access_token : void 0;
	if (!token) throw new Error("spark exchange returned no access token");
	if (typeof data.refresh_token !== "string" || data.refresh_token.length === 0) throw new Error("spark exchange returned no refresh token");
	if (typeof data.expires_in !== "number" || data.expires_in <= 0) throw new Error("spark exchange returned no usable expiry");
	return { accessToken: token, refreshToken: data.refresh_token, emailAddress: data.email ?? void 0, expiresAt: Date.now() + data.expires_in * 1000 };
}
function isPermanentSparkError(error) {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return msg.includes("invalid grant") || msg.includes("expired") || msg.includes("401") || msg.includes("403");
}
class SparkStreamTranslator {
	chunks = []; blockIndex = 0; sawToolCall = false;
	push(event) {
		if (!event?.choices?.length) return;
		const choice = event.choices[0];
		if (choice?.finish_reason) { this.sawToolCall = choice.finish_reason === "tool_calls"; return; }
		const delta = choice.delta;
		if (delta === void 0 || delta === null) return;
		if (typeof delta.content === "string" && delta.content.length > 0) this.chunks.push({ type: "text-delta", index: this.blockIndex, text: delta.content });
		const tcs = delta.tool_calls;
		if (!Array.isArray(tcs)) return;
		for (const tc of tcs) {
			if (tc?.index !== void 0) this.blockIndex = tc.index;
			if (tc?.id !== void 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, id: ToolCallId(tc.id) });
			if (tc?.type !== void 0 && tc.type !== "function") continue;
			const fn = tc.function;
			if (fn === void 0) continue;
			if (typeof fn.name === "string" && fn.name.length > 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, name: fn.name });
			if (typeof fn.arguments === "string" && fn.arguments.length > 0) this.chunks.push({ type: "tool-call-delta", index: this.blockIndex, argumentsDelta: fn.arguments });
		}
	}
	finish() {
		this.chunks.push({ type: "finish", reason: { kind: this.sawToolCall ? "tool-calls" : "stop" } });
		if (this.chunks.length > 0 && this.chunks[this.chunks.length - 1].type !== "usage") this.chunks.push({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } });
		return this.chunks;
	}
}
class SparkAdapter extends LlmAdapter {
	constructor(options) { super(); this.options = options; this.catalog = new ModelCatalogCache(options.catalogStore); }
	providerInfo(provider) { return { id: provider, name: "iFlytek Spark (Subscription)" }; }
	staticModels(provider) { return (this.options.models ?? SPARK_MODELS).map((m) => ({ provider, id: m.id, name: m.name ?? m.id, inputModalities: m.inputModalities ?? SPARK_MODALITIES })); }
	async listModels(provider) { if (await this.options.tokens.peek() === void 0) return []; return this.staticModels(provider); }
	async resolveModel(provider, model) {
		const configured = (this.options.models ?? SPARK_MODELS).find((m) => m.id === model);
		return { provider, id: model, name: configured?.name ?? model, inputModalities: SPARK_MODALITIES, context: { contextWindow: configured?.contextWindow ?? SPARK_CONTEXT_WINDOW }, defaultMaxTokens: configured?.maxTokens ?? SPARK_DEFAULT_MAX_TOKENS };
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			const session = await this.options.tokens.session();
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) throw new LlmError("spark API token invalid; re-login via Settings → Subscriptions", "INVALID_CREDENTIAL");
			if (!response.ok) throw await httpLlmError(response, "spark API");
			if (response.body === null) throw new LlmError("spark API returned no response body", EMPTY_RESPONSE_CODE);
			const translator = new SparkStreamTranslator();
			for await (const sseEvent of parseSse(response.body, () => { watchdog.pulse(); })) {
				let event;
				try { event = JSON.parse(sseEvent.data); }
				catch { throw new LlmError("spark API returned a malformed SSE payload", "MALFORMED_RESPONSE"); }
				translator.push(event);
				for (const emitted of translator.chunks) yield emitted;
				translator.chunks = [];
			}
			yield* translator.finish();
		} catch (error) { throw mapFetchFailure("spark API", error, watchdog, options.signal); }
		finally { watchdog.stop(); }
	}
	async request(options, session, signal) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const chatMessages = messages.map((m) => {
			if (m.role === "system") return { role: "system", content: m.content };
			if (m.role === "user" && typeof m.content === "string") return { role: "user", content: m.content };
			if (m.role === "user" && Array.isArray(m.content)) {
				const parts = [];
				for (const c of m.content) { if (c.type === "text") parts.push({ type: "text", text: c.text }); else if (c.type === "image_url") parts.push(c); }
				return { role: "user", content: parts.length === 1 ? parts[0].text : parts };
			}
			if (m.role === "assistant" && typeof m.content === "string") return { role: "assistant", content: m.content };
			return m;
		});
		const body = {
			model: options.model, messages: chatMessages, stream: true,
			...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
			...options.temperature !== void 0 ? { temperature: options.temperature } : {},
			...options.tools !== void 0 && options.tools.length > 0 ? { tools: options.tools.map((t) => ({ type: "function", function: t.function })) } : {}
		};
		return fetch(SPARK_API_URL, {
			method: "POST",
			headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json", accept: "text/event-stream", ...attributionHeaders() },
			body: JSON.stringify(body), signal
		});
	}
}
async function refreshSpark(session) {
	const response = await fetch(SPARK_TOKEN_URL, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: session.refreshToken,
			client_id: sparkClientId(),
			client_secret: sparkClientSecret()
		})
	});
	if (!response.ok) throw await oauthEndpointError(response, "spark");
	const data = await response.json();
	return { ...session, accessToken: data.access_token, refreshToken: data.refresh_token ?? session.refreshToken, expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : session.expiresAt };
}
//#endregion
//#region src/providers/ernie.ts
/** Baidu ERNIE Bot subscription provider: OAuth PKCE → access token.
 *
 * ERNIE Bot's Open Platform uses standard OAuth2. Users register an app at
 * baidu.com and provide client_id/client_secret via environment variables.
 * The access token is passed as a URL parameter (Baidu convention) against
 * the ERNIE RPC endpoint.
 *
 * Docs: https://cloud.baidu.com/doc/WENXINWORKSHOP/s/jlil56u11 */
const ERNIE_CLIENT_ID_ENV = "ERNIE_CLIENT_ID";
const ERNIE_CLIENT_SECRET_ENV = "ERNIE_CLIENT_SECRET";
const ERNIE_AUTHORIZE_URL = "https://openapi.baidu.com/oauth/2.0/authorize";
const ERNIE_TOKEN_URL = "https://openapi.baidu.com/oauth/2.0/token";
const ERNIE_API_BASE = "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat";
const ERNIE_CALLBACK_PATH = "/callback";
const ERNIE_CONTEXT_WINDOW = 8192;
const ERNIE_DEFAULT_MAX_TOKENS = 2048;
const ERNIE_PREEMPT_MS = 5 * 6e4;
const ERNIE_MODALITIES = ["text"];
const ERNIE_MODELS = [
	{ id: "ernie-4.0", name: "ERNIE 4.0", contextWindow: 8192, maxTokens: 2048 },
	{ id: "ernie-lite-8k", name: "ERNIE Lite 8K", contextWindow: 8192, maxTokens: 2048 },
	{ id: "ernie-turbo-8k", name: "ERNIE Turbo 8K", contextWindow: 8192, maxTokens: 2048 }
];
function ernieClientId() { return process.env[ERNIE_CLIENT_ID_ENV] ?? ""; }
function ernieClientSecret() { return process.env[ERNIE_CLIENT_SECRET_ENV] ?? ""; }
const ernieFlow = {
	callbackPath: ERNIE_CALLBACK_PATH,
	listen: { host: "localhost", ports: [0] },
	buildAuthorizeUrl({ state, pkce }) {
		const url = new URL(ERNIE_AUTHORIZE_URL);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", ernieClientId());
		url.searchParams.set("redirect_uri", ernieFlow.listen.host + ERNIE_CALLBACK_PATH);
		url.searchParams.set("code_challenge", pkce.challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", state);
		return url.toString();
	}
};
async function exchangeErnieCode(code, verifier, signal) {
	const response = await fetch(ERNIE_TOKEN_URL, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			redirect_uri: ernieFlow.listen.host + ERNIE_CALLBACK_PATH,
			client_id: ernieClientId(),
			client_secret: ernieClientSecret(),
			code_verifier: verifier
		}), signal
	});
	if (!response.ok) throw await oauthEndpointError(response, "ernie");
	const data = await response.json();
	const token = typeof data.access_token === "string" ? data.access_token : void 0;
	if (!token) throw new Error("ernie exchange returned no access token");
	if (typeof data.refresh_token !== "string" || data.refresh_token.length === 0) throw new Error("ernie exchange returned no refresh token");
	if (typeof data.expires_in !== "number" || data.expires_in <= 0) throw new Error("ernie exchange returned no usable expiry");
	return { accessToken: token, refreshToken: data.refresh_token, emailAddress: void 0, expiresAt: Date.now() + data.expires_in * 1000 };
}
function isPermanentErnieError(error) {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return msg.includes("invalid grant") || msg.includes("expired") || msg.includes("401") || msg.includes("403");
}
class ErnieStreamTranslator {
	chunks = []; blockIndex = 0; sawToolCall = false;
	push(event) {
		if (!event?.result) return;
		const text = typeof event.result === "string" ? event.result : "";
		if (text.length > 0) this.chunks.push({ type: "text-delta", index: this.blockIndex, text });
		if (event.is_finish) { this.sawToolCall = false; return; }
	}
	finish() {
		this.chunks.push({ type: "finish", reason: { kind: this.sawToolCall ? "tool-calls" : "stop" } });
		if (this.chunks.length > 0 && this.chunks[this.chunks.length - 1].type !== "usage") this.chunks.push({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } });
		return this.chunks;
	}
}
class ErnieAdapter extends LlmAdapter {
	constructor(options) { super(); this.options = options; this.catalog = new ModelCatalogCache(options.catalogStore); }
	providerInfo(provider) { return { id: provider, name: "Baidu ERNIE (Subscription)" }; }
	staticModels(provider) { return (this.options.models ?? ERNIE_MODELS).map((m) => ({ provider, id: m.id, name: m.name ?? m.id, inputModalities: m.inputModalities ?? ERNIE_MODALITIES })); }
	async listModels(provider) { if (await this.options.tokens.peek() === void 0) return []; return this.staticModels(provider); }
	async resolveModel(provider, model) {
		const configured = (this.options.models ?? ERNIE_MODELS).find((m) => m.id === model);
		return { provider, id: model, name: configured?.name ?? model, inputModalities: ERNIE_MODALITIES, context: { contextWindow: configured?.contextWindow ?? ERNIE_CONTEXT_WINDOW }, defaultMaxTokens: configured?.maxTokens ?? ERNIE_DEFAULT_MAX_TOKENS };
	}
	async *stream(options) {
		const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
		try {
			const session = await this.options.tokens.session();
			let response = await this.request(options, session, watchdog.signal);
			if (response.status === 401) throw new LlmError("ernie API token invalid; re-login via Settings → Subscriptions", "INVALID_CREDENTIAL");
			if (!response.ok) throw await httpLlmError(response, "ernie API");
			if (response.body === null) throw new LlmError("ernie API returned no response body", EMPTY_RESPONSE_CODE);
			const translator = new ErnieStreamTranslator();
			for await (const sseEvent of parseSse(response.body, () => { watchdog.pulse(); })) {
				let event;
				try { event = JSON.parse(sseEvent.data); }
				catch { throw new LlmError("ernie API returned a malformed SSE payload", "MALFORMED_RESPONSE"); }
				translator.push(event);
				for (const emitted of translator.chunks) yield emitted;
				translator.chunks = [];
			}
			yield* translator.finish();
		} catch (error) { throw mapFetchFailure("ernie API", error, watchdog, options.signal); }
		finally { watchdog.stop(); }
	}
	async request(options, session, signal) {
		const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
		const chatMessages = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
		const systemMessage = messages.find((m) => m.role === "system");
		const modelName = options.model.replace("ernie-", "").replace("ernie_blossom", "ernie-bot") || "ernie-bot";
		const body = {
			messages: chatMessages,
			...systemMessage ? { system: systemMessage.content } : {},
			stream: true,
			...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {}
		};
		return fetch(`${ERNIE_API_BASE}/${modelName}?access_token=${session.accessToken}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream", ...attributionHeaders() },
			body: JSON.stringify(body), signal
		});
	}
}
async function refreshErnie(session) {
	const response = await fetch(ERNIE_TOKEN_URL, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: session.refreshToken,
			client_id: ernieClientId(),
			client_secret: ernieClientSecret()
		})
	});
	if (!response.ok) throw await oauthEndpointError(response, "ernie");
	const data = await response.json();
	return { ...session, accessToken: data.access_token, refreshToken: data.refresh_token ?? session.refreshToken, expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : session.expiresAt };
}
//#endregion


//#region src/index.ts
const name = "dsh-plugin-subscriptions";
const inject = ["llm"];
/** Default maximum provider idle time while one stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Built-in catalogs used when the config does not override a provider's models. */
const DEFAULT_MODELS = {
	codex: [
		{
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex"
		},
		{
			id: "gpt-5.1-codex-mini",
			name: "GPT-5.1 Codex Mini"
		},
		{
			id: "gpt-5.1",
			name: "GPT-5.1"
		}
	],
	claude: [
		{
			id: "claude-opus-5",
			name: "Claude Opus 5",
			maxTokens: 128e3,
			contextWindow: 1e6
		},
		{
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			maxTokens: 128e3,
			contextWindow: 1e6
		},
		{
			id: "claude-fable-5",
			name: "Claude Fable 5",
			maxTokens: 128e3,
			contextWindow: 1e6
		},
		{
			id: "claude-haiku-4-5-20251001",
			name: "Claude Haiku 4.5",
			maxTokens: 64e3
		}
	],
	grok: [
		{
			id: "grok-4",
			name: "Grok 4"
		},
		{
			id: "grok-4-fast-reasoning",
			name: "Grok 4 Fast Reasoning"
		},
		{
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1"
		}
	],
	antigravity: [
		{ id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", contextWindow: 1_048_576, maxTokens: 65536 },
		{ id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", contextWindow: 1_048_576, maxTokens: 65536 },
		{ id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", contextWindow: 1_048_576, maxTokens: 65536 },
		{ id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", contextWindow: 1_048_576, maxTokens: 65536 },
		{ id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", contextWindow: 1_048_576, maxTokens: 65536 },
		{ id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", contextWindow: 1_048_576, maxTokens: 65536 },
		{ id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", apiId: "gemini-pro-agent", contextWindow: 1_048_576, maxTokens: 65535 },
		{ id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", contextWindow: 1_048_576, maxTokens: 65535 },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", contextWindow: 1_048_576, maxTokens: 65536 },
		{ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", contextWindow: 1_048_576, maxTokens: 65536 },
		{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", contextWindow: 1_048_576, maxTokens: 65536 }
	],
	openrouter: [
		{ id: "openai/gpt-4o", name: "GPT-4o (OpenRouter)", contextWindow: 128e3, maxTokens: 16384 },
		{ id: "openai/gpt-4o-mini", name: "GPT-4o Mini (OpenRouter)", contextWindow: 128e3, maxTokens: 16384 },
		{ id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (OpenRouter)", contextWindow: 200e3, maxTokens: 32768 },
		{ id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (OpenRouter)", contextWindow: 200e3, maxTokens: 32768 },
		{ id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (OpenRouter)", contextWindow: 1e6, maxTokens: 65536 }
	],
	agnes: [
		{ id: "agnes-2.5-flash", name: "Agnes 2.5 Flash", contextWindow: 524288, maxTokens: 16384 },
		{ id: "agnes-2.0-flash", name: "Agnes 2.0 Flash", contextWindow: 262144, maxTokens: 16384 },
		{ id: "openai/gpt-4o", name: "GPT-4o (via Agnes)", contextWindow: 128e3, maxTokens: 16384 },
		{ id: "anthropic/claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 (via Agnes)", contextWindow: 200e3, maxTokens: 32768 }
	],
	qwen: [
		{ id: "qwen-max", name: "Qwen-Max", contextWindow: 131072, maxTokens: 8192 },
		{ id: "qwen-plus", name: "Qwen-Plus", contextWindow: 131072, maxTokens: 8192 },
		{ id: "qwen-turbo", name: "Qwen-Turbo", contextWindow: 131072, maxTokens: 8192 },
		{ id: "qwen-long", name: "Qwen-Long", contextWindow: 1000000, maxTokens: 8192 }
	],
	spark: [
		{ id: "spark-4.0", name: "Spark 4.0", contextWindow: 16384, maxTokens: 4096 },
		{ id: "spark-3.5-max", name: "Spark 3.5 Max", contextWindow: 16384, maxTokens: 4096 },
		{ id: "spark-lite", name: "Spark Lite", contextWindow: 8192, maxTokens: 2048 }
	],
	ernie: [
		{ id: "ernie-4.0", name: "ERNIE 4.0", contextWindow: 8192, maxTokens: 2048 },
		{ id: "ernie-lite-8k", name: "ERNIE Lite 8K", contextWindow: 8192, maxTokens: 2048 },
		{ id: "ernie-turbo-8k", name: "ERNIE Turbo 8K", contextWindow: 8192, maxTokens: 2048 }
	]
};
/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models) {
	const resolve = (provider) => {
		const configured = models?.[provider];
		return validateModels(configured !== void 0 && configured.length > 0 ? configured : DEFAULT_MODELS[provider], `${name}: models.${provider}`);
	};
	return {
		codex: resolve("codex"),
		claude: resolve("claude"),
		grok: resolve("grok"),
		antigravity: resolve("antigravity"),
		openrouter: resolve("openrouter"),
		agnes: resolve("agnes"),
		qwen: resolve("qwen"),
		spark: resolve("spark"),
		ernie: resolve("ernie")
	};
}
/** The display account of a stored session, for the status endpoint. */
function accountOf(provider, session) {
	if (session === void 0) return void 0;
	switch (provider) {
		case "codex": {
			const codex = session;
			return codex.emailAddress ?? codexProfileClaims(codex.idToken).emailAddress ?? codex.accountId;
		}
		case "claude": return session.emailAddress;
		case "grok": return session.account;
		case "antigravity": return session.emailAddress;
		case "openrouter": return session.emailAddress ?? "OpenRouter user";
		case "agnes": return session.userInfo?.id ?? "Agnes user";
		case "qwen": return session.emailAddress ?? "Qwen user";
		case "spark": return session.emailAddress ?? "Spark user";
		case "ernie": return session.emailAddress ?? "ERNIE user";
	}
}
/**
* Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
* OAuth attempts in the background, feed pasted codes, cancel, log out, and
* answer usage lookups.
*/
var SubscriptionsAuthController = class {
	/** Last login failure per provider, surfaced as `detail` until the next success. */
	lastError = /* @__PURE__ */ new Map();
	constructor(flows, deviceFlows, onAuthChanged, resolveAttachments, usageFetchers = {}) {
		this.flows = flows;
		this.deviceFlows = deviceFlows;
		this.onAuthChanged = onAuthChanged;
		this.resolveAttachments = resolveAttachments;
		this.usageFetchers = usageFetchers;
		this.preparingFlows = new Map();
		this.disposed = false;
	}
	usage(provider, signal) {
		const fetcher = this.usageFetchers[provider];
		if (fetcher === void 0) return Promise.resolve({ supported: false });
		return fetcher(signal);
	}
	async readImage(ref, signal) {
		const attachments = this.resolveAttachments();
		if (attachments === void 0) throw new Error("no attachment service is mounted; generated-image bytes are unavailable");
		const stored = await attachments.readImage(ref, signal);
		return {
			mediaType: stored.ref.mediaType,
			dataBase64: Buffer.from(stored.data).toString("base64")
		};
	}
	async readVideo(name$1, signal) {
		return {
			mediaType: "video/mp4",
			dataBase64: (await readFile(join(videosDirectory(), name$1), { signal })).toString("base64")
		};
	}
	async status(provider) {
		const session = await getSession(provider);
		const account = accountOf(provider, session);
		const detail = this.lastError.get(provider);
		const deviceFlow = provider === "qwen" ? this.deviceFlows?.pending("qwen") : void 0;
		const busy = this.flows.isBusy(provider) || (deviceFlow !== void 0);
		return {
			loggedIn: session !== void 0,
			busy,
			...session === void 0 ? {} : { expiresAt: session.expiresAt },
			...account === void 0 ? {} : { account },
			...detail === void 0 ? {} : { detail },
			...deviceFlow !== void 0 ? {
				authorizeUrl: deviceFlow.verificationUriComplete ?? deviceFlow.verificationUri ?? "",
				userCode: deviceFlow.userCode,
				expiresAt: deviceFlow.expiresAt,
			} : {}
		};
	}
	async login(provider) {
		if (this.disposed) throw new Error("subscriptions hub is shutting down");
		if (provider === "claude") {
			const session = readClaudeCodeCredentials();
			if (session) {
				await this.persist("claude", session);
				this.lastError.delete("claude");
				this.onAuthChanged("claude");
				return { authorizeUrl: "" };
			}
			throw new Error("Claude Code credentials not found. Run \"claude\" first to log in.");
		}
		if (provider === "qwen") {
			if (this.deviceFlows?.isBusy("qwen")) {
				// Already in progress — return current auth info so UI stays consistent.
				const pending = this.deviceFlows.pending("qwen");
				return {
					authorizeUrl: pending?.verificationUriComplete ?? pending?.verificationUri ?? "",
					userCode: pending?.userCode,
					expiresAt: pending?.expiresAt,
					busy: true,
				};
			}
			const pkce = createPkce();
			const abortController = new AbortController();
			const reservation = this.deviceFlows?.reserve("qwen", abortController);
			if (reservation === void 0) throw new Error("a qwen login attempt is already in progress");
			const starting = startQwenDeviceFlow(pkce, abortController.signal);
			reservation.completion = starting;
			let flow;
			try {
				flow = await starting;
				abortController.signal.throwIfAborted();
				if (!this.deviceFlows?.set("qwen", reservation, flow)) throw new Error("login cancelled");
			} catch (error) {
				this.deviceFlows?.delete("qwen", reservation);
				throw error;
			}
			flow.signal = abortController.signal;
			flow.abortController = abortController;
			// Fire-and-forget background poll; controller methods drive cancel/logout.
			flow.completion = runQwenDevicePoll(flow, this);
			return {
				authorizeUrl: flow.verificationUriComplete ?? flow.verificationUri ?? "",
				userCode: flow.userCode,
				expiresAt: flow.expiresAt,
				busy: true,
			};
		}
		let spec;
		if (provider === "grok") {
			const preparation = { controller: new AbortController(), completion: void 0 };
			this.preparingFlows.set(provider, preparation);
			preparation.completion = grokFlow(preparation.controller.signal);
			try {
				spec = await preparation.completion;
			} finally {
				if (this.preparingFlows.get(provider) === preparation) this.preparingFlows.delete(provider);
			}
		} else spec = provider === "antigravity" ? antigravityFlow : provider === "openrouter" ? openrouterFlow : provider === "agnes" ? agnesFlow : provider === "spark" ? sparkFlow : provider === "ernie" ? ernieFlow : codexFlow;
		if (this.disposed) throw new Error("subscriptions hub is shutting down");
		const attempt = await this.flows.start(provider, spec);
		attempt.completion = this.complete(provider, attempt);
		return { authorizeUrl: attempt.authorizeUrl };
	}
	/** Drive one attempt to a stored session; records failures for the status endpoint. */
	async complete(provider, attempt) {
		try {
			const code = await attempt.waitCode();
			const session = await this.exchange(provider, code, attempt);
			attempt.signal.throwIfAborted();
			await this.persist(provider, session, attempt.signal);
			this.lastError.delete(provider);
			this.onAuthChanged(provider);
		} catch (error) {
			if (!attempt.signal.aborted && !(error instanceof Error && error.message === "login cancelled")) this.lastError.set(provider, safeDiagnostic(error));
		} finally {
			attempt.finish();
		}
	}
	exchange(provider, code, attempt) {
		switch (provider) {
			case "codex": return exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.signal);
			case "claude": return exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state, attempt.signal);
			case "grok": return exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge, attempt.signal);
			case "antigravity": return exchangeAntigravityCode(code, attempt.pkce.verifier, attempt.signal);
			case "openrouter": return exchangeOpenRouterCode(code, attempt.pkce.verifier, attempt.signal);
			case "agnes": return exchangeAgnesCode(code, attempt.state, attempt.signal);
			case "spark": return exchangeSparkCode(code, attempt.pkce.verifier, attempt.signal);
			case "ernie": return exchangeErnieCode(code, attempt.pkce.verifier, attempt.signal);
		}
	}
	persist(provider, session, signal) {
		signal?.throwIfAborted();
		switch (provider) {
			case "codex": return saveSession("codex", session, authFilePath(), signal);
			case "claude": return saveSession("claude", session, authFilePath(), signal);
			case "grok": return saveSession("grok", session, authFilePath(), signal);
			case "antigravity": return saveSession("antigravity", session, authFilePath(), signal);
			case "openrouter": return saveSession("openrouter", session, authFilePath(), signal);
			case "agnes": return saveSession("agnes", session, authFilePath(), signal);
			case "qwen": return saveSession("qwen", session, authFilePath(), signal);
			case "spark": return saveSession("spark", session, authFilePath(), signal);
			case "ernie": return saveSession("ernie", session, authFilePath(), signal);
		}
	}
	manual(provider, input) {
		const attempt = this.flows.pending(provider);
		if (attempt === void 0) return Promise.reject(/* @__PURE__ */ new Error(`no ${provider} login attempt is in progress`));
		attempt.manual(input);
		return Promise.resolve();
	}
	async cancel(provider) {
		const preparing = this.preparingFlows.get(provider);
		preparing?.controller.abort(new Error("login cancelled"));
		await this.flows.cancel(provider);
		await this.deviceFlows?.cancel(provider);
		await preparing?.completion?.catch(() => undefined);
		this.onAuthChanged(provider);
	}
	async logout(provider) {
		await this.cancel(provider);
		await deleteSession(provider);
		this.lastError.delete(provider);
		this.onAuthChanged(provider);
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const preparation of this.preparingFlows.values()) preparation.controller.abort(new Error("login cancelled"));
		await Promise.all([this.flows.stop(), this.deviceFlows?.stop(), ...[...this.preparingFlows.values()].map((entry) => entry.completion?.catch(() => undefined))]);
	}
};

let storeWrites = Promise.resolve();
function saveSession(...args) { const next = storeWrites.then(() => saveSessionUnqueued(...args)); storeWrites = next.catch(() => {}); return next; }

function deleteSession(...args) { const next = storeWrites.then(() => deleteSessionUnqueued(...args)); storeWrites = next.catch(() => {}); return next; }
export { fetchCodexModels, fetchClaudeModels, fetchGrokModels, fetchAntigravityModels, DeviceFlowManager, SubscriptionsAuthController, TokenManager, CodexAdapter, ClaudeAdapter, GrokAdapter, AntigravityAdapter, getSession, saveSession, deleteSession, loadStore, DEFAULT_MODELS, parseSse, fetchCodexUsage, fetchClaudeUsage, fetchGrokUsage, fetchAntigravityUsage, refreshCodex, refreshClaude, refreshGrok, refreshAntigravity, refreshQwen, refreshAgnes, refreshSpark, refreshErnie, codexSession, readClaudeCodeCredentials, OAuthFlowManager, catalogStore, safeDiagnostic };
