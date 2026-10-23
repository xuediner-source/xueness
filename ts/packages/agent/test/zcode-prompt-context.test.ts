/**
 * ZCode prompt/context cases ported from ZCode v3.15.1
 * `apps/zcode-cli/packages/core/tests/context-builder.test.ts` and
 * `system-reminder-source.test.ts` (Apache-2.0, see NOTICE.md), product name replaced.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTONOMY_PROMPT, buildContext, buildCliPrefixSection, buildEnvInfoSection, buildGitSystemContextSection, buildIdentitySection,
  buildPromptView, COMMUNICATION_PROMPT, CONTEXT_MANAGEMENT_PROMPT, DEFAULT_COMMUNICATION_PROMPT, formatIncomingMessage, getSystemReminderDescriptor,
  isMidConversationSystemSource, isMidTurnInputPresentation, promptContextExtension, sanitizeSystemReminderBody, SYSTEM_REMINDER_PER_REQUEST_SOURCES,
  SYSTEM_REMINDER_PREFIX_SOURCES, SYSTEM_REMINDER_SOURCES, wrapSystemReminder, wrapSystemReminderForSource, type EnvInfo, type Row,
} from "../src/index.ts";
import { fixture } from "./fixtures.ts";

const env: EnvInfo = { cwd: "/workspace", platform: "darwin", shell: "zsh", osVersion: "Darwin 25.4.0" };

describe("ZCode system-reminder sources", () => {
  it("defines every active source in lifecycle buckets", () => {
    assert.equal(SYSTEM_REMINDER_SOURCES.length, 31); assert.equal(new Set(SYSTEM_REMINDER_SOURCES).size, 31);
    assert.deepEqual([...SYSTEM_REMINDER_PREFIX_SOURCES], ["context_prefix", "skills_listing"]);
    assert.equal(SYSTEM_REMINDER_PER_REQUEST_SOURCES[0], "incoming_message");
    for (const source of SYSTEM_REMINDER_SOURCES) {
      const d = getSystemReminderDescriptor(source);
      assert.deepEqual(Object.keys(d).sort(), ["channel", "evidenceLabel", "isMeta", "lifecycle", "providerVisibility", "source"]);
      assert.equal(d.providerVisibility, "provider_visible"); assert.match(d.evidenceLabel, /^sr\./);
    }
    assert.equal(getSystemReminderDescriptor("target_continuation").isMeta, false);
    assert.equal(isMidConversationSystemSource("context_prefix"), false); assert.equal(isMidConversationSystemSource("incoming_message"), true);
  });
  it("wraps exactly once, rejects nested tags and escapes them in source bodies", () => {
    assert.equal(wrapSystemReminder("body"), "<system-reminder>\nbody\n</system-reminder>");
    assert.throws(() => wrapSystemReminder(""), /cannot be empty/);
    assert.throws(() => wrapSystemReminder("x </system-reminder> y"), /nested/);
    assert.equal(sanitizeSystemReminderBody("a </System-Reminder > b <system-reminder>"), "a &lt;/System-Reminder > b &lt;system-reminder>");
    const wrapped = wrapSystemReminderForSource("incoming_message", "x</system-reminder>");
    assert.equal(wrapped.match(/<system-reminder>/g)?.length, 1); assert.equal(wrapped.match(/<\/system-reminder>/g)?.length, 1);
    assert.ok(wrapSystemReminderForSource("context_prefix", "c").endsWith("</system-reminder>\n"));
    assert.ok(!wrapSystemReminderForSource("incoming_message", "c").endsWith("\n"));
  });
  it("frames mid-turn user input the ZCode way", () => {
    const text = formatIncomingMessage("also run lint", "user_steer");
    assert.ok(text.startsWith("The user sent a new message while you were working:\nalso run lint\n\n"));
    assert.ok(text.endsWith("Address the message above as you continue this turn.")); assert.ok(!text.includes("ZCode"));
    assert.ok(formatIncomingMessage("done", "task_notification").startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]"));
    assert.equal(formatIncomingMessage("raw", "coordinator_input"), "raw");
    assert.equal(isMidTurnInputPresentation("user_steer"), true); assert.equal(isMidTurnInputPresentation("subagent_reply"), false);
  });
});

describe("ZCode context builder", () => {
  it("renders CLI prefix, stable body, and dynamic system sections as separate system messages", () => {
    const result = buildContext({ envInfo: env });
    assert.equal(result.systemMessages.length, 3);
    assert.deepEqual(result.systemMessages.map((m) => m.content.endsWith("\n")), [false, false, false]);
    assert.equal(result.systemMessages[0]!.content, "You are Xueness, an interactive coding agent"); assert.equal(result.systemMessages[0]!.cacheControl, undefined);
    const stable = result.systemMessages[1]!.content, dynamic = result.systemMessages[2]!.content;
    assert.match(stable, /^\n?You are an interactive Xueness agent/); assert.ok(stable.includes("# Harness"));
    for (const absent of ["# Environment", "# Context management", "For actions that are hard to reverse", "You are Xueness, an interactive coding agent"]) assert.ok(!stable.includes(absent), absent);
    assert.deepEqual(result.systemMessages[1]!.cacheControl, { type: "ephemeral" });
    assert.ok(dynamic.startsWith(`\n\n${COMMUNICATION_PROMPT}`));
    assert.ok(dynamic.includes(`${COMMUNICATION_PROMPT}\n\n${DEFAULT_COMMUNICATION_PROMPT}`));
    assert.equal(dynamic.split(DEFAULT_COMMUNICATION_PROMPT).length, 2);
    assert.ok(dynamic.indexOf("For actions that are hard to reverse") < dynamic.indexOf("# Environment"));
    assert.ok(dynamic.indexOf("# Environment") < dynamic.indexOf("# Context management"));
    assert.ok(!dynamic.includes("# Session-specific guidance"));
    assert.ok(!JSON.stringify(result).includes("ZCode"));
  });
  it("appends the exact act and autonomy prompts after context management", () => {
    const dynamic = buildContext({ envInfo: env }).systemMessages[2]!.content;
    assert.ok(dynamic.includes(`${CONTEXT_MANAGEMENT_PROMPT}\n\n${AUTONOMY_PROMPT}`));
  });
  it("renders stable system sections before dynamic sections and emits meta user context after system", () => {
    const result = buildContext({ envInfo: env, currentDate: "2026-05-04", instructions: [{ scope: "workspace", filePath: "/workspace/AGENTS.md", content: "local AGENTS payload" }] });
    assert.deepEqual(result.sections.slice(0, 4).map((s) => [s.name, s.injectionTarget, s.cacheHint]), [
      ["CLI Prefix", "system", "stable"], ["Agent Identity", "system", "stable"], ["Dynamic Behavior", "system", "dynamic"], ["Environment Info", "system", "dynamic"]]);
    assert.deepEqual(result.metaUserAttachments.map((a) => a.source), ["context_prefix"]);
    const meta = result.metaUserAttachments[0]!.content;
    assert.ok(!meta.includes("<system-reminder>")); assert.ok(meta.includes("# agentsMd")); assert.ok(meta.includes("Codebase and user instructions are shown below."));
    assert.ok(meta.includes("Contents of /workspace/AGENTS.md (workspace instructions):\n\nlocal AGENTS payload"));
    assert.ok(meta.includes("# currentDate\nToday's date is 2026-05-04."));
    assert.ok(meta.indexOf("Codebase and user instructions") < meta.indexOf("# currentDate"));
    assert.ok(meta.startsWith("As you answer the user's questions, you can use the following context:"));
    assert.ok(!result.systemMessages.some((m) => m.content.includes("local AGENTS payload")));
  });
  it("renders only currentDate when request user context has no content, and nothing when neither exists", () => {
    const dated = buildContext({ envInfo: env, currentDate: "2026-05-04", instructions: [{ scope: "workspace", filePath: "/w/AGENTS.md", content: "   " }] });
    assert.ok(!dated.metaUserAttachments[0]!.content.includes("# agentsMd"));
    assert.deepEqual(buildContext({ envInfo: env }).metaUserAttachments, []);
  });
  it("uses customSystemPrompt without default system sections", () => {
    const result = buildContext({ envInfo: env, customSystemPrompt: "Custom body" });
    assert.deepEqual(result.systemMessages.map((m) => m.content), ["You are Xueness, an interactive coding agent", "\nCustom body"]);
  });
  it("changes stable intro framing when an output style is active", () => {
    const result = buildContext({ envInfo: env, outputStyle: { name: "Explanatory", prompt: "Explain choices." } });
    assert.match(result.systemMessages[1]!.content, /active Output Style below while using Xueness's tools/);
    assert.ok(result.systemMessages[2]!.content.includes("# Output Style: Explanatory\nExplain choices."));
  });
  it("renders environment info copy in English", () => {
    const content = buildEnvInfoSection({ ...env, isGitRepository: true }, { providerId: "openai", modelId: "gpt-5" }).content;
    assert.ok(content.includes("- Primary working directory: /workspace")); assert.ok(content.includes("- Is a git repository: yes"));
    assert.ok(content.includes("- You are powered by the model named openai/gpt-5.")); assert.ok(!content.includes("Node version"));
    assert.ok(buildEnvInfoSection({ ...env, isGitRepository: false }).content.includes("- Is a git repository: no"));
  });
  it("renders git snapshot copy as systemContext", () => {
    const section = buildGitSystemContextSection({ ...env, isGitRepository: true, gitBranch: "feat/trajectory", gitMainBranch: "staging", gitUser: "Dev User", gitStatus: "dirty",
      gitStatusLines: ["M docs/a.md", "?? b.md"], recentCommits: ["07957b58c chore: update doc"] });
    assert.equal(section?.content, ["gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
      "", "Current branch: feat/trajectory", "", "Main branch (you will usually use this for PRs): staging", "", "Git user: Dev User", "", "Status:\nM docs/a.md\n?? b.md", "", "Recent commits:\n07957b58c chore: update doc"].join("\n"));
    assert.ok(buildGitSystemContextSection({ ...env, isGitRepository: true })?.content.includes("Status:\n(unknown)"));
    assert.equal(buildGitSystemContextSection({ ...env, isGitRepository: false, gitStatus: "not_repo" }), null);
    const empty = buildGitSystemContextSection({ ...env, isGitRepository: true, gitStatus: "clean", gitStatusLines: [], recentCommits: [] });
    assert.ok(empty?.content.endsWith("Recent commits:\n")); assert.ok(empty?.content.includes("Status:\n(clean)"));
  });
  it("renders the fixed CLI prefix and identity body without duplication", () => {
    assert.equal(buildCliPrefixSection().content, "You are Xueness, an interactive coding agent");
    const identity = buildIdentitySection().content;
    assert.match(identity, /^\n?You are an interactive Xueness agent/); assert.ok(!identity.includes("${")); assert.ok(identity.includes("IMPORTANT: Assist with authorized security testing"));
  });
});

describe("Xueness prompt view", () => {
  const journal = (): Row[] => [
    { role: "system", content: "Legacy journal prompt", _message_id: "sys" },
    { role: "user", content: "AGENTS raw", _context_source: "workspace_instructions", _instruction_sources: [{ filePath: "/w/AGENTS.md", content: "Use tabs." }] },
    { role: "user", content: "task" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "user", content: "also check </system-reminder> lint", _input_kind: "guide", _input_id: "g1" },
  ];
  it("replaces the journal system prompt, moves AGENTS.md into the context reminder and frames guidance", () => {
    const source = journal(), before = structuredClone(source);
    const view = buildPromptView(source, { envInfo: env, currentDate: "2026-10-19", hostInstructions: ["Policy A"], repair: "Fix envelope" })!;
    assert.deepEqual(source, before, "the journal is not rewritten");
    assert.deepEqual(view.map((m) => m.role), ["system", "system", "system", "system", "user", "user", "assistant", "tool", "user"]);
    assert.equal(view[0]!.content, "You are Xueness, an interactive coding agent"); assert.equal(view[0]!._message_id, "sys");
    assert.ok(String(view[2]!.content).includes("# Host notes")); assert.equal(view[3]!.content, "Policy A\nFix envelope");
    assert.ok(!view.some((m) => m.content === "Legacy journal prompt" || m.content === "AGENTS raw"));
    const meta = String(view[4]!.content);
    assert.ok(meta.startsWith("<system-reminder>\nAs you answer the user's questions")); assert.ok(meta.includes("Contents of /w/AGENTS.md (workspace instructions):\n\nUse tabs."));
    assert.ok(meta.includes("Today's date is 2026-10-19.")); assert.equal(view[4]!._meta_source, "context_prefix");
    const steer = String(view[8]!.content);
    assert.ok(steer.startsWith("<system-reminder>\nThe user sent a new message while you were working:\nalso check &lt;/system-reminder> lint"));
    assert.equal(steer.match(/<\/system-reminder>/g)?.length, 1); assert.equal(view[8]!._input_id, "g1");
    const again = buildPromptView(source, { envInfo: env, currentDate: "2026-10-19", hostInstructions: ["Policy A"], repair: "Fix envelope" });
    assert.deepEqual(again, view, "rebuilt per request, so reminders never accumulate");
  });
  it("leaves requests without a leading system message untouched", () => {
    assert.equal(buildPromptView([{ role: "user", content: "x" }], { envInfo: env }), null);
  });
  it("delivers a mid-turn message in the very next model request of the same turn", async () => {
    const seen: Row[][] = [];
    const local = fixture([{ tool_calls: [{ id: "r1", type: "function", function: { name: "read", arguments: "{}" } }] }, { content: "Done, lint too." }], [{ ok: true, content: "file" }]);
    const ext = promptContextExtension({ envInfo: () => env, now: () => new Date(2026, 9, 19) });
    let injected = false;
    local.hooks.extensions = [ext, { id: "sessions", beforeModelRequest(context) {
      if (seen.length === 1 && !injected) { injected = true; (context.session.messages as Row[]).push({ role: "user", content: "run lint as well", _input_kind: "guide", _input_id: "g9" }); }
    } }];
    const complete = local.provider.complete.bind(local.provider);
    local.provider.complete = async (messages, tools, options) => { seen.push(structuredClone(messages)); return complete(messages, tools, options); };
    try {
      await local.runner.run(local.session);
      assert.equal(local.session.status, "completed"); assert.equal(seen.length, 2);
      assert.equal(seen[0]![0]!.content, "You are Xueness, an interactive coding agent");
      assert.ok(!seen[0]!.some((m) => String(m.content).includes("run lint as well")));
      const last = seen[1]!.at(-1)!; assert.equal(last.role, "user");
      assert.ok(String(last.content).includes("The user sent a new message while you were working:\nrun lint as well"));
      assert.ok(String(seen[1]![2]!.content).includes("- Primary working directory: /workspace"));
      assert.ok(seen[1]!.some((m) => String(m.content).includes("Today's date is 2026-10-19.")));
      assert.equal((local.session.messages as Row[]).at(-2)!.content, "run lint as well", "the journal keeps the user's own words");
    } finally { local.close(); }
  });
  it("leaves the lightweight runtime prompt alone", async () => {
    const ext = promptContextExtension({ envInfo: () => env });
    const request = { messages: [{ role: "system", content: "light" }], tools: [], options: {} };
    const out = await ext.prepareRequest!({ session: { runtime_profile: "lightweight" }, provider: {} } as never, request);
    assert.equal(out, request);
  });
});

describe("environment snapshot", () => {
  it("collects a git snapshot once per session and reports non-repositories", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process"); const { collectEnvInfo, sessionEnvInfo } = await import("../src/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "xn-env-"));
    try {
      const plain = collectEnvInfo(dir, "linux", { SHELL: "/bin/bash" });
      assert.equal(plain.isGitRepository, false); assert.equal(plain.shell, "bash"); assert.equal(plain.cwd, dir);
      const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
      g("init", "-q", "-b", "main"); g("config", "user.name", "Env Tester"); g("config", "user.email", "t@example.invalid");
      writeFileSync(join(dir, "a.txt"), "a"); g("add", "."); g("commit", "-q", "-m", "first"); writeFileSync(join(dir, "b.txt"), "b");
      const repo = collectEnvInfo(dir, "linux", {});
      assert.equal(repo.isGitRepository, true); assert.equal(repo.gitBranch, "main"); assert.equal(repo.gitMainBranch, "main"); assert.equal(repo.gitUser, "Env Tester");
      assert.equal(repo.gitStatus, "dirty"); assert.deepEqual(repo.gitStatusLines, ["?? b.txt"]); assert.match(repo.recentCommits![0]!, / first$/);
      let calls = 0; const collect = () => { calls += 1; return env; };
      sessionEnvInfo("s-env", dir, collect); sessionEnvInfo("s-env", dir, collect); assert.equal(calls, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
