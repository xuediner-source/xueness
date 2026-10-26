/**
 * F07.06 plugin SDK and contribution contract.
 *
 * Everything a data package may declare is public, declarative and typed
 * here: components (see `components.ts`), settings, and events. The contract
 * is enforced by `validateContributionFields` (wired into the inline audit)
 * and `contributionIssues` (the standalone checklist a contributor runs
 * before submitting). Compatibility is a rule, not a hope: a package targets
 * `SDK_API_VERSION`, and `compatVerdict` decides host/package fit before
 * anything is installed. `EXAMPLE_PACKAGE` is a complete, isolated example
 * plugin: building, installing, enabling, disabling and uninstalling it
 * exercises the whole contract without copying any main-app code.
 */
import { isDict } from "@xueness/contracts";
import { validateComponents, type ComponentDeclaration, type ComponentIssue } from "./components.ts";
import { validateDataManifest } from "./sdk.ts";

export const SDK_API_VERSION = 1;
/** Fields a marketplace package may never carry: frontend mounting and plugin defaults are powers of trusted build manifests only. */
export const BUILD_ONLY_FIELDS = ["features", "frontendModules", "panels", "defaultEnabled"] as const;
const SETTING_TYPES = new Set(["string", "number", "boolean", "enum"]);
const EVENT_NAME = /^[a-z][a-z0-9_-]{0,63}(\.[a-z][a-z0-9_-]{0,63})+$/u;
const MAX_SETTINGS = 32;
const MAX_EVENTS = 32;

export type ContributionIssue = ComponentIssue;

/** Public SDK types. A package document is data; nothing in it executes. */
export interface SettingDeclaration {
  type: "string" | "number" | "boolean" | "enum";
  title: string;
  description: string;
  default: unknown;
  required: boolean;
  options?: readonly string[];
}

export interface EventDeclaration {
  name: string;
  description: string;
}

export interface PluginPackageDocument {
  id: string;
  version: string;
  apiVersion: number;
  enabled: boolean;
  builtin: string;
  capabilities: readonly string[];
  dependencies?: readonly string[];
  name?: string;
  description?: string;
  components?: Record<string, readonly unknown[]>;
  settings?: Record<string, unknown>;
  events?: readonly unknown[];
}

export type SdkCompatibility =
  | { supported: true; mode: "exact" | "legacy"; note: string }
  | { supported: false; reason: "package-newer" | "host-older" | "invalid"; note: string };

/** Compatibility rule: one major line at a time, older minors supported. */
export function compatVerdict(packageApiVersion: unknown, hostApiVersion: number = SDK_API_VERSION): SdkCompatibility {
  if (typeof packageApiVersion !== "number" || !Number.isInteger(packageApiVersion) || packageApiVersion < 1) {
    return { supported: false, reason: "invalid", note: "apiVersion must be a positive integer" };
  }
  if (packageApiVersion === hostApiVersion) return { supported: true, mode: "exact", note: `targets SDK apiVersion ${hostApiVersion}` };
  if (packageApiVersion < hostApiVersion) {
    return { supported: true, mode: "legacy", note: `package targets apiVersion ${packageApiVersion}; host ${hostApiVersion} runs it in compatibility mode` };
  }
  return { supported: false, reason: "package-newer", note: `package needs SDK apiVersion ${packageApiVersion}; this host provides ${hostApiVersion}` };
}

function settingIssues(id: string, settings: unknown, issues: ContributionIssue[]): void {
  if (!isDict(settings)) {
    issues.push({ path: `${id}/settings`, message: "settings must be an object of setting declarations" });
    return;
  }
  const keys = Object.keys(settings);
  if (keys.length > MAX_SETTINGS) issues.push({ path: `${id}/settings`, message: `at most ${MAX_SETTINGS} settings are allowed` });
  for (const key of keys) {
    const at = `${id}/settings/${key}`;
    const entry = settings[key];
    if (!isDict(entry) || typeof entry.type !== "string" || !SETTING_TYPES.has(entry.type)) {
      issues.push({ path: at, message: "setting must declare type string|number|boolean|enum" });
      continue;
    }
    if (typeof entry.title !== "string" || entry.title.length === 0 || entry.title.length > 64) issues.push({ path: `${at}/title`, message: "title must be 1-64 characters" });
    if (typeof entry.description !== "string" || entry.description.length > 200) issues.push({ path: `${at}/description`, message: "description must be at most 200 characters" });
    if (entry.required !== undefined && typeof entry.required !== "boolean") issues.push({ path: `${at}/required`, message: "required must be a boolean" });
    if (entry.type === "enum") {
      const options = entry.options;
      if (!Array.isArray(options) || options.length === 0 || options.some((option) => typeof option !== "string") || new Set(options).size !== options.length) {
        issues.push({ path: `${at}/options`, message: "enum settings need unique non-empty string options" });
      }
    }
  }
}

function eventIssues(id: string, events: unknown, issues: ContributionIssue[]): void {
  if (!Array.isArray(events)) {
    issues.push({ path: `${id}/events`, message: "events must be an array of event declarations" });
    return;
  }
  if (events.length > MAX_EVENTS) issues.push({ path: `${id}/events`, message: `at most ${MAX_EVENTS} events are allowed` });
  const namespace = (id.startsWith("xueness-") ? id.slice("xueness-".length) : id).replaceAll("_", "-");
  const seen = new Set<string>();
  for (const [index, entry] of events.entries()) {
    const at = `${id}/events/${index}`;
    if (!isDict(entry) || typeof entry.name !== "string") {
      issues.push({ path: at, message: "event must be an object with a name" });
      continue;
    }
    if (!EVENT_NAME.test(entry.name)) {
      issues.push({ path: `${at}/name`, message: "event names are dot-separated lowercase segments" });
      continue;
    }
    if (!entry.name.startsWith(`${namespace}.`)) {
      issues.push({ path: `${at}/name`, message: `event must be namespaced ${namespace}.*` });
      continue;
    }
    if (typeof entry.description !== "string" || entry.description.length === 0 || entry.description.length > 200) {
      issues.push({ path: `${at}/description`, message: "description must be 1-200 characters" });
      continue;
    }
    if (seen.has(entry.name)) issues.push({ path: at, message: `duplicate event: ${entry.name}` });
    seen.add(entry.name);
  }
}

/** Shape audit of the SDK-owned fields (`components`, `settings`, `events`). */
export function validateContributionFields(item: Record<string, unknown>, id: string): ContributionIssue[] {
  const issues: ContributionIssue[] = [];
  if (item.components !== undefined) {
    const [, componentIssues] = validateComponents(item.components, id);
    issues.push(...componentIssues);
  }
  if (item.settings !== undefined) settingIssues(id, item.settings, issues);
  if (item.events !== undefined) eventIssues(id, item.events, issues);
  return issues;
}

/** The standalone contribution checklist: manifest shape plus SDK fields plus compatibility. */
export function contributionIssues(document: unknown): ContributionIssue[] {
  if (!isDict(document)) return [{ path: "<package>", message: "package document must be a JSON object" }];
  const id = typeof document.id === "string" ? document.id : "<package>";
  const [manifest, shape] = validateDataManifest(document);
  const issues: ContributionIssue[] = shape.map((message) => ({ path: id, message }));
  for (const field of BUILD_ONLY_FIELDS) {
    if (document[field] !== undefined) issues.push({ path: `${id}/${field}`, message: `${field} is a build-manifest power; a package document cannot mount frontend or set defaults` });
  }
  const verdict = compatVerdict(document.apiVersion);
  if (!verdict.supported) issues.push({ path: `${id}/apiVersion`, message: verdict.note });
  if (manifest) {
    issues.push(...validateContributionFields(document, manifest.id));
    if (Array.isArray(document.dependencies) && document.dependencies.includes(manifest.id)) {
      issues.push({ path: `${id}/dependencies`, message: "package must not depend on itself" });
    }
  }
  return issues;
}

export interface PackageDescription {
  id: string;
  version: string;
  builtin: string;
  apiVersion: number;
  compat: SdkCompatibility;
  capabilities: string[];
  dependencies: string[];
  components: { total: number; byKind: Record<string, string[]>; alwaysLoad: string[] };
  settings: string[];
  events: string[];
}

/** Normalize any conforming package document into the panel/docs summary. */
export function describePackage(document: unknown): PackageDescription | null {
  if (!isDict(document)) return null;
  const [manifest, shape] = validateDataManifest(document);
  if (!manifest || shape.length) return null;
  const [components] = validateComponents(document.components, manifest.id);
  const byKind: Record<string, string[]> = {};
  for (const component of components) byKind[component.kind] = [...(byKind[component.kind] ?? []), component.id];
  const settings = isDict(document.settings) ? Object.keys(document.settings).sort() : [];
  const events = Array.isArray(document.events)
    ? document.events.filter(isDict).map((entry) => entry.name).filter((name): name is string => typeof name === "string")
    : [];
  return {
    id: manifest.id,
    version: manifest.version,
    builtin: manifest.builtin,
    apiVersion: manifest.apiVersion,
    compat: compatVerdict(manifest.apiVersion),
    capabilities: manifest.capabilities,
    dependencies: Array.isArray(document.dependencies) ? document.dependencies.filter((dep): dep is string => typeof dep === "string") : [],
    components: {
      total: components.length,
      byKind,
      alwaysLoad: components.filter((component) => component.alwaysLoad).map((component) => `${component.kind}/${component.id}`),
    },
    settings,
    events: [...events].sort(),
  };
}

/** The isolated example plugin: one package, three component kinds, the `command` tool power, settings and namespaced events. */
export const EXAMPLE_PACKAGE: PluginPackageDocument = {
  id: "xueness-example-greeter",
  version: "1.0.0",
  apiVersion: SDK_API_VERSION,
  enabled: false,
  builtin: "skills",
  capabilities: ["command"],
  name: "Example greeter",
  description: "Isolated example plugin: declarative components, settings and events only.",
  components: {
    skills: [{ id: "greeting", description: "Compose a greeting for a name", alwaysLoad: false }],
    commands: [{ id: "greet", description: "Print a greeting using the configured style", alwaysLoad: true }],
    hooks: [{ id: "on-session-start", description: "Emit the example.session-started event", alwaysLoad: false }],
  },
  settings: {
    style: { type: "enum", title: "Greeting style", description: "Wording used by the greet command", default: "casual", required: true, options: ["casual", "formal"] },
  },
  events: [{ name: "example-greeter.session-started", description: "Emitted once per session start" }],
};
