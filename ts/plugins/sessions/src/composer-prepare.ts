/**
 * `POST /api/composer/prepare` (Python `composer_api._prepare`): validate one
 * draft, expand its slash command, quote the selected context and attachments,
 * pin the model choice, and cache the result for one trusted, same-root use.
 */
import { randomBytes } from "node:crypto";
import { dirname, basename } from "node:path";
import { isDict, pyLen, pyStrip } from "@xueness/contracts";
import { attachmentMetadata, realish, withAttachments, type Attachment } from "@xueness/sessions";
import { decodeBrowserAttachments, checkKeys, resolveRefs, workspaceAttachments } from "./composer-attachments.ts";
import { skillsCatalog, type ComposerCatalogOptions } from "./composer-catalog.ts";
import { capabilityContext, pluginContext, sessionContext, skillContext, type SkillReader } from "./composer-context.ts";
import { remoteSelection } from "./composer-remote.ts";
import { ComposerError, isolatedRoots, readSession, requestRoot, requireEnabled, resolveRoot, SID_RE } from "./composer-roots.ts";
import type { MediaRef } from "./media-db.ts";
import type { Owner } from "./media-owner.ts";
import { ownerRow } from "./queue-media.ts";

type Row = Record<string, unknown>;
const REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODES = ["build", "edit", "yolo", "plan", "guarded"];
const MAX_TEXT = 5000, MAX_PREPARED = 6 * 1024 * 1024, TTL_SECONDS = 300, MAX_ENTRIES = 8;

export interface ComposerOptions extends ComposerCatalogOptions {
  running: ReadonlySet<string>;
  allPluginIds(): readonly string[];
  readSkill?: SkillReader;
  models?(): { options: readonly Row[]; choices: ReadonlyMap<string, Row> };
  /** `provider_config.resolve(state, id or None, model, reasoning_effort=...)`. */
  resolveModel?(providerId: string | null, model: string, effort: string | null): { capabilities: Iterable<unknown> };
  configurationGuidance?: string;
  /** `commands.expand(commands.load(state, root, language=...), text)`. */
  expand?(text: string, root: string, language: unknown): { text: string; invocation: Row | null };
}

/** `_check_list`: unique short strings, bounded. */
export function checkList(value: unknown, field: string, max = 8): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item || pyLen(item) > 1024) || new Set(value).size !== value.length) throw new ComposerError(400, "invalid " + field);
  return [...value as string[]];
}

/** `_provider_for_prepare`: the pinned choice and its freshly resolved provider. */
function providerForPrepare(o: ComposerOptions, data: Row, effort: unknown): [Row, { capabilities: Iterable<unknown> }] {
  requireEnabled(o, "providers");
  if (o.allowReal !== true) throw new ComposerError(403, "real provider disabled; set XUENESS_ALLOW_REAL=1");
  const providerId = data.provider_id, model = data.model;
  if (providerId !== undefined && providerId !== null && (typeof providerId !== "string" || pyLen(providerId) > 64)) throw new ComposerError(400, "invalid model selection");
  if (model !== undefined && model !== null && (typeof model !== "string" || !pyStrip(model) || pyLen(model) > 200)) throw new ComposerError(400, "invalid model selection");
  if (effort !== undefined && effort !== null && (typeof effort !== "string" || !REASONING.has(effort))) throw new ComposerError(400, "invalid reasoning effort");
  const chosen = typeof providerId === "string" ? providerId : "";
  const choice = o.models?.().choices.get(chosen);
  const guidance = o.configurationGuidance ?? "model provider is not configured";
  if (!choice) throw new ComposerError(400, chosen ? "model selection unavailable" : guidance);
  if (choice.configured !== true) throw new ComposerError(400, guidance);
  const selected = choice.model as string;
  if (model !== undefined && model !== null && model !== selected) throw new ComposerError(400, "model selection unavailable");
  let resolved: { capabilities: Iterable<unknown> };
  try {
    if (!o.resolveModel) throw new Error("unavailable");
    resolved = o.resolveModel(chosen || null, selected, typeof effort === "string" ? effort : null);
  } catch { throw new ComposerError(400, "model selection unavailable"); }
  if (typeof effort === "string" && !(Array.isArray(choice.reasoningLevels) && choice.reasoningLevels.includes(effort))) throw new ComposerError(400, "reasoning effort is unavailable for this model");
  return [choice, resolved];
}

interface Cached { root: string; text: string; metadata: Row; goal: boolean; expiresAt: number; media_sources?: Row[]; edit_prefix?: string }
/** The one-shot draft cache (`_cache_prepared`, `consume_prepared`). */
export class PreparedCache {
  readonly #entries = new Map<string, Cached>();
  readonly #now: () => number;
  constructor(now: () => number = () => performance.now() / 1000) { this.#now = now; }
  #prune(now: number): void { for (const [token, item] of this.#entries) if (item.expiresAt <= now) this.#entries.delete(token); }
  put(root: string, text: string, metadata: Row, goal: boolean, editPrefix: string | null, mediaSources: Row[]): string {
    if (pyLen(text) > MAX_PREPARED) throw new ComposerError(400, "prepared input exceeds the size limit");
    const now = this.#now();
    this.#prune(now);
    while (this.#entries.size >= MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
    let token = randomBytes(16).toString("hex");
    while (this.#entries.has(token)) token = randomBytes(16).toString("hex");
    const entry: Cached = { root, text, metadata, goal, expiresAt: now + TTL_SECONDS, ...mediaSources.length ? { media_sources: mediaSources } : {} };
    if (typeof editPrefix === "string" && text.startsWith(editPrefix)) entry.edit_prefix = editPrefix;
    this.#entries.set(token, entry);
    return token;
  }
  /** A draft prepared for the isolated root may start a generated `web-runs/<id>` session. */
  take(o: Pick<ComposerOptions, "webRuns">, token: unknown, root: string): Row {
    if (typeof token !== "string" || !SID_RE.test(token)) throw new ComposerError(400, "prepared input invalid or expired");
    this.#prune(this.#now());
    const item = this.#entries.get(token), webRuns = realish(o.webRuns);
    const same = !!item && (item.root === root || item.root === webRuns && root !== webRuns && dirname(root) === webRuns && SID_RE.test(basename(root)));
    if (!item || !same) throw new ComposerError(400, "prepared input invalid or expired");
    this.#entries.delete(token);
    return { text: item.text, root: item.root, metadata: item.metadata, goal: item.goal, ...item.media_sources?.length ? { media_sources: item.media_sources } : {}, ...item.edit_prefix !== undefined ? { edit_prefix: item.edit_prefix } : {} };
  }
}

/** `consume_prepared`: the root must be permitted now, not only when prepared. */
export function consumePrepared(o: ComposerOptions, cache: PreparedCache, token: unknown, root: unknown): Row {
  if (typeof token !== "string" || !SID_RE.test(token)) throw new ComposerError(400, "prepared input invalid or expired");
  let requested: string;
  try { requested = resolveRoot(o, root); } catch { throw new ComposerError(400, "prepared input invalid or expired"); }
  return cache.take(o, token, requested);
}

const mediaKind = (mime: string): string | null => mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : mime.startsWith("video/") ? "video" : null;

/** `/name …`: the enabled skill whose id or name is `name` (case-insensitive), if any. */
export function slashSkillId(o: ComposerCatalogOptions, text: string): string | null {
  const match = /^\/([^\s/]+)(?=\s|$)/u.exec(text);
  if (!match || !o.enabled("skills")) return null;
  const name = match[1]!.toLowerCase();
  const hit = skillsCatalog(o).find((row) => [row.id, row.label].some((value) => typeof value === "string" && value.toLowerCase() === name));
  return hit ? String(hit.id) : null;
}
export async function prepareInput(o: ComposerOptions, cache: PreparedCache, data: unknown): Promise<Row> {
  const body = checkKeys(data, ["text", "root", "session_id", "provider_id", "model", "reasoning_effort", "permission_mode", "input", "language"], "request");
  if (body.permission_mode !== undefined && body.permission_mode !== null && !PERMISSION_MODES.includes(body.permission_mode as string)) throw new ComposerError(400, "permission_mode must be 'build', 'edit', 'yolo', 'plan', or 'guarded'");
  if (typeof body.text !== "string" || pyLen(body.text) > MAX_TEXT) throw new ComposerError(400, "text must be at most 5000 characters");
  const text = pyStrip(body.text);
  const input = checkKeys(Object.hasOwn(body, "input") ? body.input : {}, ["attachments", "attachmentRefs", "files", "sessions", "skills", "plugins", "capabilities", "remote", "goal"], "input");
  const goal = Object.hasOwn(input, "goal") ? input.goal : false;
  if (typeof goal !== "boolean") throw new ComposerError(400, "invalid goal flag");
  if (goal) requireEnabled(o, "planning");
  const sid = body.session_id;
  if (sid !== undefined && sid !== null && (typeof sid !== "string" || pyLen(sid) > 64)) throw new ComposerError(400, "invalid session selection");
  const root = requestRoot(o, body.root, sid), isolated = isolatedRoots(o).includes(root);
  const files = checkList(input.files, "workspace file selection", 4), sessions = checkList(input.sessions, "session selection");
  const skills = checkList(input.skills, "skill selection"), plugins = checkList(input.plugins, "plugin selection"), capabilities = checkList(input.capabilities, "capability selection");
  if (capabilities.includes("browser.composer_operation") && typeof sid === "string" && o.running.has(sid) && !readSession(o, sid)?.browser_enabled) throw new ComposerError(409, "enable browser before starting a run; browser capability cannot be added to an active run");
  if (isolated && (files.length || sessions.length)) throw new ComposerError(400, "isolated workspaces cannot reference shared files or sessions");
  if (files.length) requireEnabled(o, "files");
  let promptText = text; const invocations: Row[] = [];
  if (o.enabled("commands")) {
    let expanded: { text: string; invocation: Row | null };
    try { if (!o.expand) throw new Error("unavailable"); expanded = o.expand(text, root, body.language); }
    catch { throw new ComposerError(403, "plugin disabled or dependency unavailable: commands"); }
    promptText = expanded.text;
    if (expanded.invocation !== null) invocations.push(expanded.invocation);
  }
  // ZCode lists skills in the "/" menu: "/name …" that no command claimed selects the enabled skill with that name.
  const slashSkill = invocations.length ? null : slashSkillId(o, text);
  if (slashSkill !== null && !skills.includes(slashSkill)) skills.push(slashSkill);
  const [remoteMetadata, remoteBlock] = Object.hasOwn(input, "remote") && input.remote !== null && input.remote !== undefined ? remoteSelection(o, input.remote) : [null, ""];
  const [choice, provider] = providerForPrepare(o, body, body.reasoning_effort);
  const durable: [MediaRef, Owner][] = [];
  const [refBrowser, refWorkspace] = await resolveRefs(o, root, typeof sid === "string" ? sid : null, input.attachmentRefs, durable);
  if (isolated && refWorkspace.length) throw new ComposerError(400, "isolated workspaces cannot reference shared files or sessions");
  const browser = [...await decodeBrowserAttachments(input.attachments), ...refBrowser];
  const workspace = [...await workspaceAttachments(o, root, files), ...refWorkspace];
  const attachments: Attachment[] = [...browser, ...workspace];
  if (attachments.length > 4) throw new ComposerError(400, "at most four inline attachments and workspace files are supported");
  if (attachments.length + durable.length > 8) throw new ComposerError(400, "at most eight attachments and workspace files are supported");
  const mediaTotal = attachments.filter((item) => item.mimeType).reduce((sum, item) => sum + item.size, 0);
  if (durable.reduce((sum, [ref]) => sum + ref.size, 0) + mediaTotal > 64 * 1024 * 1024) throw new ComposerError(400, "attachments exceed the total media size limit");
  const textTotal = attachments.filter((item) => !item.mimeType).reduce((sum, item) => sum + pyLen(item.content), 0);
  if (mediaTotal > 4 * 1024 * 1024 || textTotal > 16000) throw new ComposerError(400, "attachments exceed the total size limit");
  const required = new Set<string>(durable.length ? ["image"] : []);
  for (const item of attachments) { const kind = item.mimeType ? mediaKind(item.mimeType) : null; if (kind) required.add(kind); }
  const available = new Set([...provider.capabilities].filter((cap): cap is string => typeof cap === "string"));
  if ([...required].some((cap) => !available.has(cap))) throw new ComposerError(400, "selected model does not support one or more attachments");
  const sessionBlocks: string[] = [], sessionMeta: Row[] = [];
  if (sessions.length) {
    requireEnabled(o, "sessions");
    for (const id of sessions) { const [block, meta] = sessionContext(o, root, id); sessionBlocks.push(block); sessionMeta.push(meta); }
  }
  const skillBlocks: string[] = [], skillMeta: Row[] = [];
  for (const id of skills) { const [block, meta] = skillContext(o, o.readSkill, id); skillBlocks.push(block); skillMeta.push(meta); }
  const [pluginBlock, pluginMeta] = pluginContext(o, plugins);
  const [capabilityBlock, capabilityMeta] = capabilityContext(o, capabilities);
  const sections = [...sessionBlocks, ...skillBlocks, ...capabilityBlock ? [capabilityBlock] : [], ...pluginBlock ? [pluginBlock] : [], ...remoteBlock ? [remoteBlock] : []];
  let prepared = promptText + (sections.length ? "\n\n" + sections.join("\n\n") : "");
  try { prepared = withAttachments(prepared, attachments); } catch (error) { throw new ComposerError(400, (error as Error).message); }
  if (pyLen(prepared) > MAX_PREPARED) throw new ComposerError(400, "prepared input exceeds the size limit");
  if (!pyStrip(prepared) && durable.length) prepared = "Please review the attached images.";
  if (!pyStrip(prepared)) throw new ComposerError(400, "add a task, attachment or context before preparing input");
  const metadata: Row = { ...durable.length ? { media_refs: durable.map(([ref]) => ref) } : {}, attachments: browser.map(attachmentMetadata), files: workspace.map(attachmentMetadata),
    sessions: sessionMeta, skills: skillMeta, plugins: pluginMeta, capabilities: capabilityMeta, ...invocations.length ? { commandInvocations: invocations } : {},
    modelSelection: { provider_id: choice.id, model: choice.model, protocol: choice.protocol, capabilities: [...available].sort(), ...body.reasoning_effort !== undefined && body.reasoning_effort !== null ? { reasoning_effort: body.reasoning_effort } : {} } };
  if (remoteMetadata !== null) metadata.remote = remoteMetadata;
  const token = cache.put(root, prepared, metadata, goal, promptText === text ? promptText : null, durable.map(([ref, owner]) => ({ owner: ownerRow(owner), ids: [ref.id] })));
  return { token, text: prepared, root, metadata, goal };
}
