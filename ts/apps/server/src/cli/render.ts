/**
 * Terminal I/O for runs (`sessions/cli.py` `_render_event`, `_prompt`,
 * `cli_interrupt.RunInterrupt`): live events on stderr, line prompts on
 * stderr reading stdin, and Ctrl+C that stops the run at the next safe point.
 */
import { createInterface, type Interface } from "node:readline";
import { pySlice } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";
import type { ApprovalAnswer, ApprovalRequest, Approver } from "@xueness/tool-bridge";
import { cliErrorOutput } from "./output.ts";
import type { TuiAttachment, TuiContext, TuiPort, TuiQuestion } from "@xueness/plugin-sessions";

type Row = Record<string, any>;
type Out = { write(text: string): unknown };

export function renderEvent(ev: Row, options: { file?: Out; language?: string; stream?: Row } = {}): void {
  const out = options.file ?? cliErrorOutput, en = options.language === "en", state = options.stream;
  const line = (text: string): void => { out.write(text + "\n"); };
  const type = ev.type;
  if (type === "assistant_delta") {
    const delta = String(ev.text || "");
    if (state) state.text = String(state.text ?? "") + delta;
    if (delta) out.write(delta);
  } else if (type === "assistant") {
    const text = String(ev.text || "").trim();
    if (!text) return;
    const streamed = state && Object.hasOwn(state, "text") ? String(state.text) : null;
    if (state) delete state.text;
    if (streamed === null) line(`\n◆ ${text}`);
    else line(text.startsWith(streamed) ? text.slice(streamed.length) : "");
  } else if (type === "tool_call") {
    line(`→ ${ev.name ?? ""} ${String(ev.subject || "").trim()}`.trimEnd());
  } else if (type === "tool_result") {
    const label = ev.name || ev.subject || "";
    let text = `${ev.ok ? "✓" : "✗"} ${label}`.trimEnd();
    if (ev.error && !ev.ok) text += ` — ${typeof ev.error === "object" ? ev.error.message ?? ev.error.code : ev.error}`;
    line(text);
  } else if (type === "model_request_queued") {
    line(en ? "Waiting for model capacity…" : "等待模型并发名额…");
  } else if (type === "model_request_failed" && ev.terminal === true && ev.reason !== "cancelled") {
    const message = en ? ev.message : ev.messageZh;
    line(typeof message === "string" && message ? message : en ? "The model request failed." : "模型请求失败。");
  } else if (type === "completion") {
    const mark = ev.verified ? "✓" : "⚠", summary = String(ev.summary || "").trim(), delivery = ev.delivery_status ?? "not_assessed";
    if (en) {
      const tool = ev.verified ? "tool evidence passed" : "tool evidence needs review";
      const label = delivery === "passed" ? "delivery checks passed" : delivery === "failed" ? "delivery checks failed" : "delivery not assessed";
      line(`${mark} Run ended (${tool}; ${label})${summary ? ": " + summary : ""}`);
    } else {
      const tool = ev.verified ? "工具成功证据通过" : "工具证据待审核";
      const label = delivery === "passed" ? "交付检查通过" : delivery === "failed" ? "交付检查未通过" : "交付内容尚未检查";
      line(`${mark} 运行结束（${tool}；${label}）${summary ? ": " + summary : ""}`);
    }
  } else if (type === "status") {
    let text = en ? `== ${ev.status} (${ev.steps ?? 0} steps)` : `== ${ev.status} (共 ${ev.steps ?? 0} 步)`;
    if (ev.question) text += `\n   ${en ? "Question" : "问题"}: ${ev.question}`;
    line(text);
  }
}

/** `_event_renderer`: one stream state per run. */
export function eventRenderer(language: string): (event: Row) => void {
  const stream: Row = {};
  return (event) => renderEvent(event, { language, stream });
}

/** Stdin lines for prompts; null at end of input or Ctrl+C at a prompt. */
export interface CliTerminal {
  running: boolean;
  stopRequested: boolean;
  prompt(label: string): Promise<string | null>;
  watch(): void;
  close(): void;
  setContext?(context: TuiContext): void;
  history?(messages: readonly { role: string; content: unknown }[]): void;
  connect?(port: TuiPort): void;
  approval?(request: ApprovalRequest): Promise<ApprovalAnswer>;
  questions?(questions: readonly TuiQuestion[]): Promise<string | null>;
  reset?(sessionId?: string): void;
  event?(event: Row): void;
  takeAttachments?(): readonly TuiAttachment[];
  openMenu?(kind: "session" | "child"): void;
}

export class Terminal implements CliTerminal {
  #rl: Interface | null = null;
  #lines: string[] = [];
  #waiter: ((line: string | null) => void) | null = null;
  #closed = false;
  #signals = false;
  #onInterrupt = (): void => { this.interrupt(); };
  running = false;
  stopRequested = false;

  #open(): Interface {
    if (this.#rl) return this.#rl;
    const tty = process.stdin.isTTY === true;
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: tty });
    rl.on("line", (line) => { const waiter = this.#waiter; this.#waiter = null; if (waiter) waiter(line); else this.#lines.push(line); });
    rl.on("close", () => { this.#closed = true; const waiter = this.#waiter; this.#waiter = null; waiter?.(null); });
    rl.on("SIGINT", () => this.interrupt());
    this.#rl = rl;
    this.watch();
    return rl;
  }

  /** Route Ctrl+C here (also while no prompt is open, for one-shot runs). */
  watch(): void {
    if (this.#signals) return;
    this.#signals = true;
    process.on("SIGINT", this.#onInterrupt);
  }

  /** `RunInterrupt._interrupt`: the first Ctrl+C during a run asks it to stop. */
  interrupt(): void {
    if (this.running) {
      if (!this.stopRequested) process.stderr.write("\n正在停止：等待当前请求或工具步骤结束，随后保存会话。\n");
      this.stopRequested = true;
      const waiter = this.#waiter; this.#waiter = null; waiter?.(null);
      return;
    }
    const waiter = this.#waiter; this.#waiter = null;
    if (waiter) { process.stderr.write("\n"); waiter(null); } else process.exit(130);
  }

  /** `_prompt(label)`: the label on stderr; a blank stderr line after piped input. */
  async prompt(label: string): Promise<string | null> {
    const rl = this.#open();
    const tty = process.stdin.isTTY === true;
    if (tty) { rl.setPrompt(label); rl.prompt(); } else process.stderr.write(label);
    let line: string | null;
    if (this.#lines.length) line = this.#lines.shift()!;
    else if (this.#closed) line = null;
    else line = await new Promise<string | null>((done) => { this.#waiter = done; });
    if (!tty) process.stderr.write("\n");
    return line;
  }

  close(): void {
    this.#rl?.close(); this.#rl = null;
    if (this.#signals) process.off("SIGINT", this.#onInterrupt);
    this.#signals = false;
  }
}

export interface GateFlags {
  allowWrite: boolean; allowEdit: boolean; allowExec: boolean; allowMcp: boolean; allowNetwork: boolean;
  interactive: boolean; permissionMode: string;
}

/**
 * The CLI `Gate` decision for an ask the permission session raised: an
 * invocation flag approves its kind, `--interactive` prompts on the terminal,
 * and anything else is deferred as a pending approval a later run can replay.
 * Yolo still holds remote SSH execution (`hold_remote_exec`).
 */
export async function decideApproval(flags: GateFlags, terminal: CliTerminal, request: ApprovalRequest): Promise<ApprovalAnswer> {
  const kind = request.kind;
  const remoteHeld = request.code === "remote_exec";
  const guardedHeld = request.code === "guarded";
  if (kind === "mcp" && flags.allowMcp) return { behavior: "allow" };
  if ((kind === "web_fetch" || kind === "web_search" || kind === "network") && flags.allowNetwork) return { behavior: "allow" };
  if (!remoteHeld && !guardedHeld && ((kind === "write" && flags.allowWrite) || (kind === "edit" && flags.allowEdit) || (kind === "exec" && flags.allowExec))) return { behavior: "allow" };
  if (flags.interactive && !terminal.stopRequested) {
    if (terminal.approval) return terminal.approval(request);
    const answer = await terminal.prompt(`Approve ${kind} ${pySlice(request.subject, 160)}? [y/N] `);
    if ((answer ?? "").trim().toLowerCase() === "y") return { behavior: "allow" };
    return { behavior: "deny", message: `${kind} requires explicit approval`, reason: "user_denied" };
  }
  return { behavior: "defer" };
}

/** The agent-service approver for one CLI invocation (`approver` option). */
export function cliApprover(flags: () => GateFlags, terminal: CliTerminal): (sessionId: string, session: Session, stopped: () => boolean) => Approver {
  return (_sessionId, _session, stopped) => async (request) => {
    if (stopped() || terminal.stopRequested) return { behavior: "cancel" };
    return decideApproval(flags(), terminal, request);
  };
}
