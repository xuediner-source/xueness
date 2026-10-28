/**
 * Permission policy for one session: allow, ask or deny each tool call.
 *
 * Python's WebGate is the baseline: deny by default for the approval kinds
 * (write, edit, exec, mcp, web_fetch, web_search), one-shot approvals bound
 * to a tool-call id and its exact subject, the build / edit / yolo / plan / guarded
 * modes, and a fail-closed refusal of unknown kinds. Rules, "always allow"
 * and read-only commands come on top, in this order:
 *
 * Full access bypasses application permission policy, including deny/disallow,
 * always-ask and remote confirmation rules. Other modes retain their rules.
 *
 * Outside full access, a command line is read-only only when the parser understood all of it and
 * every simple command in it is read-only or matched by a rule, with no
 * variable assignments or writing redirections. Deny and ask rules look at
 * every command a line can run, nested and wrapped ones included. Allow
 * requires every segment that is not read-only to match; deny and ask fire
 * when any segment matches.
 */
import { isAbsolute, relative, resolve } from "node:path";
import {
  APPROVAL_KINDS, EDIT_KINDS, HOST_PATH_KINDS, isPermissionMode, isRemoteExecSubject, KNOWN_KINDS, PERMISSION_MODES, permissionSettingsIssues, PLAN_EXIT_KIND,
  type AllowCode, type AskCode, type DenyCode, type PermissionAuditEntry, type PermissionDecision, type PermissionMode,
  type PermissionRequest, type PermissionSettings, type PermissionSnapshot, type PlanDraftPolicy, type RememberOptions,
} from "./decision.ts";
import { commandSubjects, evaluateBashRules, ruleNeedle } from "./bash-rules.ts";
import { classifyShellCommand, classifySimpleCommand, redirectReadOnly } from "./readonly.ts";
import { commandsForDeny, parseRule, RuleSyntaxError, ruleCoversTool, subjectMatches, type PermissionRule } from "./rules.ts";
import { parseShell } from "./shell-parse.ts";
import { suggestRules } from "./suggest.ts";

const AUDIT_MAX = 200;
const GRANTS_MAX = 1000;

const allow = (code: AllowCode, message: string, rule?: string): PermissionDecision => ({ behavior: "allow", code, message, ...(rule ? { rule } : {}) });
const ask = (code: AskCode, message: string, remember: RememberOptions | null, rule?: string): PermissionDecision => ({ behavior: "ask", code, message, remember, ...(rule ? { rule } : {}) });
const deny = (code: DenyCode, message: string, rule?: string): PermissionDecision => ({ behavior: "deny", code, message, ...(rule ? { rule } : {}) });

interface Part {
  words: string[];
  by: "read_only" | "rule" | "session" | null;
  rule?: string;
  reason?: string;
  /** No assignments or writing redirections, so a rule can allow it. */
  coverable: boolean;
}

export class PermissionSession {
  #mode: PermissionMode;
  readonly #allow: readonly PermissionRule[];
  readonly #deny: readonly PermissionRule[];
  readonly #ask: readonly PermissionRule[];
  readonly #alwaysAsk: readonly PermissionRule[];
  readonly #disallow: ReadonlySet<string>;
  readonly #classify: boolean;
  readonly #planDraft: PlanDraftPolicy | null;
  readonly #hostWritable: readonly string[];
  readonly #guarded: PermissionSettings["guarded"] | null;
  readonly #remembered: PermissionRule[] = [];
  readonly #grants = new Map<string, { kind: string; subject: string }>();
  readonly #audit: PermissionAuditEntry[] = [];

  /** Throws RuleSyntaxError for an invalid rule and TypeError for an invalid mode. */
  constructor(settings: PermissionSettings = {}) {
    if (settings.mode === "guarded" && typeof settings.guarded !== "function") {
      throw new TypeError("guarded mode requires a guarded permission callback");
    }
    const issues = permissionSettingsIssues(settings);
    if (issues.length) {
      if (!isPermissionMode(settings.mode ?? "build")) throw new TypeError(issues[0]);
      throw new RuleSyntaxError(`invalid permission settings: ${issues.join("; ")}`);
    }
    this.#mode = settings.mode ?? "build";
    this.#allow = (settings.allow ?? []).map((text) => parseRule(text));
    this.#deny = (settings.deny ?? []).map((text) => parseRule(text));
    this.#ask = (settings.ask ?? []).map((text) => parseRule(text));
    this.#alwaysAsk = (settings.alwaysAsk ?? []).map((text) => parseRule(text));
    this.#disallow = new Set(settings.disallow ?? []);
    this.#classify = (settings.readOnlyCommands ?? true) && (settings.shell ?? "posix") === "posix";
    this.#planDraft = settings.planDraft ?? null;
    this.#hostWritable = (settings.hostWritable ?? []).filter((dir) => typeof dir === "string" && isAbsolute(dir)).map((dir) => resolve(dir));
    this.#guarded = settings.guarded ?? null;
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    if (!isPermissionMode(mode)) throw new TypeError(`permission mode must be one of ${PERMISSION_MODES.join(", ")}`);
    if (mode === "guarded" && !this.#guarded) throw new TypeError("guarded mode requires a guarded permission callback");
    this.#mode = mode;
  }

  /** The host-owned directory holding this absolute subject when a read or a file change may reach it, else null. */
  hostWritableTarget(kind: string, subject: string): string | null {
    if (!HOST_PATH_KINDS.has(kind) || !isAbsolute(subject)) return null;
    const path = resolve(subject);
    return this.#hostWritable.find((dir) => {
      const rel = relative(dir, path);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    }) ?? null;
  }

  /** The plan draft path when plan mode may write this subject, else null. */
  planDraftTarget(kind: string, subject: string): string | null {
    if (this.#mode !== "plan" || !this.#planDraft || !EDIT_KINDS.has(kind)) return null;
    return this.#planDraft.matches(subject) ? this.#planDraft.path : null;
  }

  /** Decide, spending a matching one-shot approval. */
  check(request: PermissionRequest): PermissionDecision {
    return this.#decide(request, true);
  }

  /** Decide without spending anything. */
  preview(request: PermissionRequest): PermissionDecision {
    return this.#decide(request, false);
  }

  /** Approve one pending call: it passes once, with exactly this kind and subject. */
  grantOnce(callId: string, kind: string, subject: string): void {
    if (typeof callId !== "string" || !callId) throw new TypeError("an approval needs a tool call id");
    if (!this.#grants.has(callId) && this.#grants.size >= GRANTS_MAX) {
      const [oldest, grant] = this.#grants.entries().next().value as [string, { kind: string; subject: string }];
      this.#grants.delete(oldest);
      this.#log({ action: "cleared", callId: oldest, ...grant });
    }
    this.#grants.set(callId, { kind, subject });
    this.#log({ action: "granted", kind, callId, subject });
  }

  revokeGrant(callId: string): boolean {
    const grant = this.#grants.get(callId);
    if (!grant) return false;
    this.#grants.delete(callId);
    this.#log({ action: "cleared", callId, ...grant });
    return true;
  }

  /** "Always allow" for the rest of the session; returns the canonical rule text. */
  remember(text: string): string {
    const rule = parseRule(text);
    if (!this.#remembered.some((item) => item.text === rule.text)) this.#remembered.push(rule);
    this.#log({ action: "remembered", rule: rule.text });
    return rule.text;
  }

  forget(text: string): boolean {
    const canonical = parseRule(text).text;
    const index = this.#remembered.findIndex((rule) => rule.text === canonical);
    if (index < 0) return false;
    this.#remembered.splice(index, 1);
    this.#log({ action: "forgotten", rule: canonical });
    return true;
  }

  get rememberedRules(): string[] {
    return this.#remembered.map((rule) => rule.text);
  }

  /** Who authorised what: grants, spent approvals and remembered rules, newest last. */
  get auditLog(): PermissionAuditEntry[] {
    return this.#audit.map((entry) => ({ ...entry }));
  }

  snapshot(): PermissionSnapshot {
    return {
      mode: this.#mode,
      rules: this.rememberedRules,
      grants: [...this.#grants].map(([callId, grant]) => ({ callId, ...grant })),
    };
  }

  /** Bring back a snapshot's mode, remembered rules and pending approvals. */
  restore(snapshot: PermissionSnapshot): void {
    if (!isPermissionMode(snapshot.mode)) throw new TypeError(`permission mode must be one of ${PERMISSION_MODES.join(", ")}`);
    if (snapshot.mode === "guarded" && !this.#guarded) throw new TypeError("guarded mode requires a guarded permission callback");
    const rules = snapshot.rules.map((text) => parseRule(text));
    this.#mode = snapshot.mode;
    this.#remembered.splice(0, this.#remembered.length, ...rules);
    this.#grants.clear();
    for (const grant of snapshot.grants.slice(-GRANTS_MAX)) this.#grants.set(grant.callId, { kind: grant.kind, subject: grant.subject });
  }

  #decide(request: PermissionRequest, consume: boolean): PermissionDecision {
    if (this.#mode === "yolo") return allow("mode", "full access mode");
    const { tool, kind, subject, subjectKind } = request;
    if (!KNOWN_KINDS.has(kind)) return deny("no_policy", `${kind} is not a known tool`);
    if (this.#disallow.has(kind) || this.#disallow.has(tool)) return deny("disallowed", `${this.#disallow.has(kind) ? kind : tool} is disallowed for this run`);
    const commands = subjectKind === "command" ? commandsForDeny(subject) : null;
    const denied = this.#match(this.#deny, request, commands);
    if (denied) return deny("denied_by_rule", `${tool} is denied by the rule ${denied.text}`, denied.text);
    if (subjectKind === "path" && this.hostWritableTarget(kind, subject)) return allow("host_writable", "a host-owned directory of this session");
    if (kind === PLAN_EXIT_KIND) {
      // ZCode ExitPlanMode: the plan is the user's to approve, one call at a time in modes that enforce approval.
      if (this.#mode !== "plan") return allow("auto_allowed", "not in plan mode; the tool reports it");
      return this.#spend(request, consume) ?? ask("plan_exit", `${tool} needs the user to approve the plan`, null);
    }
    const needsApproval = APPROVAL_KINDS.includes(kind);
    if (needsApproval && this.#mode === "plan") {
      if (this.planDraftTarget(kind, subject)) return allow("plan_draft", "the session's plan draft");
      if (!this.#readOnlyCommand(request)) {
        const message = this.#planDraft?.denial(kind) ?? `${kind} denied in plan mode`;
        return { behavior: "deny", code: "plan_mode", message, ...(this.#planDraft ? { planDraft: this.#planDraft.path } : {}) };
      }
    }
    const always = this.#match(this.#alwaysAsk, request, commands);
    if (always) return this.#spend(request, consume) ?? ask("always_ask", `${tool} always requires approval by the rule ${always.text}`, null, always.text);
    if (needsApproval && kind === "exec" && isRemoteExecSubject(subject)) {
      return this.#spend(request, consume) ?? ask("remote_exec", `${kind} requires explicit approval`, null);
    }
    if (this.#mode === "guarded" && kind === "exec") {
      if (!this.#guarded) return deny("no_policy", "guarded mode has no permission callback");
      let match: ReturnType<NonNullable<PermissionSettings["guarded"]>>;
      try {
        match = this.#guarded(request);
      } catch {
        return deny("no_policy", "guarded command classification failed; execution refused");
      }
      if (match) return this.#spend(request, consume) ?? ask("guarded", match.message, null, match.ruleId);
    }
    if (this.#mode === "guarded" && !needsApproval) return allow("auto_allowed", `${kind} does not need approval`);
    if (this.#mode === "guarded") return allow("mode", "guarded mode allows calls outside its finite danger rules");
    const asked = this.#match(this.#ask, request, commands);
    if (asked) return this.#spend(request, consume) ?? ask("ask_rule", `${tool} needs approval by the rule ${asked.text}`, null, asked.text);
    if (!needsApproval) return allow("auto_allowed", `${kind} does not need approval`);
    const covered = this.#covered(request);
    if (covered) return covered;
    if (this.#mode === "edit" && EDIT_KINDS.has(kind)) return allow("mode", "edit mode accepts file changes");
    return this.#spend(request, consume) ?? ask("approval_required", `${kind} requires explicit approval`, this.#suggest(request));
  }

  #suggest(request: PermissionRequest): RememberOptions | null {
    if (request.subjectKind !== "command") return suggestRules(request, null);
    const open = this.#parts(request)?.filter((part) => !part.by);
    return open && open.every((part) => part.coverable) ? suggestRules(request, open.map((part) => part.words)) : null;
  }

  #spend(request: PermissionRequest, consume: boolean): PermissionDecision | null {
    const { callId, kind, subject } = request;
    const grant = callId ? this.#grants.get(callId) : undefined;
    if (!grant || grant.kind !== kind || grant.subject !== subject) return null;
    if (consume) {
      this.#grants.delete(callId as string);
      this.#log({ action: "consumed", kind, callId: callId as string, subject });
    }
    return allow("approved", "approved once");
  }

/** Read-only exec when the shell classifier is on. Plan mode lets these through. */
  #readOnlyCommand(request: PermissionRequest): boolean {
    return this.#classify && request.kind === "exec" && request.subjectKind === "command" && classifyShellCommand(request.subject).readOnly;
  }

  /**
   * The first rule matching the request. For commands, deny and ask use
   * any-segment matching (evaluateBashRules); a tool-wide rule matches
   * everything. Allow uses the same matcher per segment in `#parts`.
   */
  #match(rules: readonly PermissionRule[], request: PermissionRequest, commands: string[][] | null): PermissionRule | null {
    for (const rule of rules) {
      if (!ruleCoversTool(rule, request.tool, request.kind)) continue;
      if (rule.specifier === null) return rule;
      if (!commands) {
        if (subjectMatches(rule, request.subjectKind, request.subject)) return rule;
        continue;
      }
      const groups = commands.map((words) => commandSubjects(words));
      if (evaluateBashRules({
        behavior: "deny",
        rules: [{ content: ruleNeedle(rule.specifier) }],
        exactCommands: [request.subject, request.subject.trim()],
        allSubjectGroups: groups,
        requiredSubjectGroups: groups,
        safe: true,
      })) return rule;
    }
    return null;
  }

  #covered(request: PermissionRequest): PermissionDecision | null {
    const bare = (rules: readonly PermissionRule[]): PermissionRule | undefined => rules.find((rule) => rule.specifier === null && ruleCoversTool(rule, request.tool, request.kind));
    if (request.subjectKind !== "command") {
      const session = this.#match(this.#remembered, request, null);
      if (session) return allow("session_rule", `allowed for this session by ${session.text}`, session.text);
      const rule = this.#match(this.#allow, request, null);
      return rule ? allow("allow_rule", `allowed by ${rule.text}`, rule.text) : null;
    }
    const always = bare(this.#remembered) ?? bare(this.#allow);
    if (always) return allow(this.#remembered.includes(always) ? "session_rule" : "allow_rule", `allowed by ${always.text}`, always.text);
    const exact = (rules: readonly PermissionRule[]): PermissionRule | undefined => rules.find((rule) => rule.specifier !== null
      && (rule.specifier === request.subject || rule.specifier === request.subject.trim()) && ruleCoversTool(rule, request.tool, request.kind));
    const sessionExact = exact(this.#remembered);
    if (sessionExact) return allow("session_rule", `allowed by ${sessionExact.text}`, sessionExact.text);
    const allowExact = exact(this.#allow);
    if (allowExact) return allow("allow_rule", `allowed by ${allowExact.text}`, allowExact.text);
    const parts = this.#parts(request);
    if (!parts || parts.some((part) => !part.by)) return null;
    const used = parts.find((part) => part.by === "session") ?? parts.find((part) => part.by === "rule");
    if (!used) return allow("read_only", `read-only command (${[...new Set(parts.map((part) => part.reason))].join(", ")})`);
    return allow(used.by === "session" ? "session_rule" : "allow_rule", `allowed by ${used.rule}`, used.rule);
  }

  /** The top-level commands of a line and what allows each; null when the line cannot be judged. */
  #parts(request: PermissionRequest): Part[] | null {
    const parsed = parseShell(request.subject);
    if (parsed.unsafe.length || !parsed.commands.length) return null;
    return parsed.commands.map((command): Part => {
      const coverable = command.words.length > 0 && !command.assignments.length && command.redirects.every(redirectReadOnly);
      const verdict = this.#classify ? classifySimpleCommand(command) : null;
      if (verdict?.readOnly) return { words: command.words, by: "read_only", reason: verdict.reason, coverable };
      if (!coverable) return { words: command.words, by: null, coverable };
      const find = (rules: readonly PermissionRule[]): PermissionRule | undefined => rules.find((rule) => rule.specifier !== null
        && ruleCoversTool(rule, request.tool, request.kind) && evaluateBashRules({
          behavior: "allow",
          rules: [{ content: ruleNeedle(rule.specifier) }],
          exactCommands: [command.words.join(" ")],
          allSubjectGroups: [commandSubjects(command.words)],
          requiredSubjectGroups: [commandSubjects(command.words)],
          safe: true,
        }));
      const session = find(this.#remembered);
      if (session) return { words: command.words, by: "session", rule: session.text, coverable };
      const rule = find(this.#allow);
      return rule ? { words: command.words, by: "rule", rule: rule.text, coverable } : { words: command.words, by: null, coverable };
    });
  }

  #log(entry: Omit<PermissionAuditEntry, "at">): void {
    this.#audit.push({ at: Date.now(), ...entry });
    if (this.#audit.length > AUDIT_MAX) this.#audit.splice(0, this.#audit.length - AUDIT_MAX);
  }
}
