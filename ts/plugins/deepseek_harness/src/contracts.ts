/**
 * Zero-glue DeepSeek Harness contribution contracts (H01.01).
 *
 * External harness packages declare tools, hooks, verifiers, skills and
 * prompt templates as data. This module is the typed surface the adapter
 * mounts into Xueness — no core packages are modified, and nothing here
 * evaluates or executes harness source code.
 */

/** SDK apiVersion a harness package must target. */
export const HARNESS_CONTRACT_API_VERSION = 1 as const;

export type HarnessContributionKind =
  | "tool"
  | "hook"
  | "verifier"
  | "skill"
  | "promptTemplate";

/** One tool a harness wants the host to expose. */
export interface HarnessToolContract {
  kind: "tool";
  name: string;
  gate: string;
  mutating: boolean;
  description: string;
}

/** One lifecycle hook a harness wants registered. */
export interface HarnessHookContract {
  kind: "hook";
  event: string;
  handler: string;
}

/** One gate/verifier a harness contributes. */
export interface HarnessVerifierContract {
  kind: "verifier";
  name: string;
  command: string;
}

/** One skill document a harness contributes. */
export interface HarnessSkillContract {
  kind: "skill";
  id: string;
  path: string;
}

/** One prompt template a harness contributes. */
export interface HarnessPromptTemplateContract {
  kind: "promptTemplate";
  id: string;
  template: string;
}

export type HarnessContribution =
  | HarnessToolContract
  | HarnessHookContract
  | HarnessVerifierContract
  | HarnessSkillContract
  | HarnessPromptTemplateContract;

/** Declarative package the adapter mounts. Pure data — no entrypoints. */
export interface HarnessPackageContract {
  sdkApiVersion: typeof HARNESS_CONTRACT_API_VERSION;
  id: string;
  version: string;
  contributions: readonly HarnessContribution[];
}

export interface ContractIssue {
  path: string;
  message: string;
}

const ID = /^[a-z][a-z0-9_]{0,63}$/;
const NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a raw package document into a typed contract (or issues). */
export function parseHarnessPackage(document: unknown): { ok: true; package: HarnessPackageContract } | { ok: false; issues: ContractIssue[] } {
  const issues: ContractIssue[] = [];
  if (!isObject(document)) return { ok: false, issues: [{ path: "/", message: "package must be an object" }] };
  if (document.sdkApiVersion !== HARNESS_CONTRACT_API_VERSION) {
    issues.push({ path: "/sdkApiVersion", message: `must equal ${HARNESS_CONTRACT_API_VERSION}` });
  }
  if (typeof document.id !== "string" || !ID.test(document.id)) {
    issues.push({ path: "/id", message: "must be a lowercase snake id" });
  }
  if (typeof document.version !== "string" || !document.version.trim()) {
    issues.push({ path: "/version", message: "must be a non-empty version string" });
  }
  const raw = Array.isArray(document.contributions) ? document.contributions : null;
  if (raw === null) issues.push({ path: "/contributions", message: "must be an array" });
  const contributions: HarnessContribution[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < (raw?.length ?? 0); index += 1) {
    const item = raw![index];
    const path = `/contributions/${index}`;
    if (!isObject(item) || typeof item.kind !== "string") {
      issues.push({ path, message: "must be an object with a kind" });
      continue;
    }
    let contribution: HarnessContribution | null = null;
    if (item.kind === "tool") {
      if (typeof item.name !== "string" || !NAME.test(item.name)) issues.push({ path: `${path}/name`, message: "invalid tool name" });
      else if (typeof item.gate !== "string" || !item.gate.trim()) issues.push({ path: `${path}/gate`, message: "gate required" });
      else if (typeof item.mutating !== "boolean") issues.push({ path: `${path}/mutating`, message: "mutating must be boolean" });
      else contribution = { kind: "tool", name: item.name, gate: item.gate, mutating: item.mutating, description: typeof item.description === "string" ? item.description : "" };
    } else if (item.kind === "hook") {
      if (typeof item.event !== "string" || !item.event.trim()) issues.push({ path: `${path}/event`, message: "event required" });
      else if (typeof item.handler !== "string" || !item.handler.trim()) issues.push({ path: `${path}/handler`, message: "handler required" });
      else contribution = { kind: "hook", event: item.event, handler: item.handler };
    } else if (item.kind === "verifier") {
      if (typeof item.name !== "string" || !NAME.test(item.name)) issues.push({ path: `${path}/name`, message: "invalid verifier name" });
      else contribution = { kind: "verifier", name: item.name, command: typeof item.command === "string" ? item.command : "" };
    } else if (item.kind === "skill") {
      if (typeof item.id !== "string" || !item.id.trim()) issues.push({ path: `${path}/id`, message: "skill id required" });
      else contribution = { kind: "skill", id: item.id, path: typeof item.path === "string" ? item.path : "" };
    } else if (item.kind === "promptTemplate") {
      if (typeof item.id !== "string" || !item.id.trim()) issues.push({ path: `${path}/id`, message: "template id required" });
      else if (typeof item.template !== "string" || !item.template.trim()) issues.push({ path: `${path}/template`, message: "template body required" });
      else contribution = { kind: "promptTemplate", id: item.id, template: item.template };
    } else {
      issues.push({ path: `${path}/kind`, message: `unknown kind ${item.kind}` });
    }
    if (contribution) {
      const key = contribution.kind === "tool" || contribution.kind === "verifier"
        ? `${contribution.kind}:${contribution.name}`
        : contribution.kind === "hook"
          ? `hook:${contribution.event}:${contribution.handler}`
          : `${contribution.kind}:${"id" in contribution ? contribution.id : ""}`;
      if (seen.has(key)) issues.push({ path, message: `duplicate contribution ${key}` });
      else {
        seen.add(key);
        contributions.push(contribution);
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    package: {
      sdkApiVersion: HARNESS_CONTRACT_API_VERSION,
      id: document.id as string,
      version: document.version as string,
      contributions,
    },
  };
}
