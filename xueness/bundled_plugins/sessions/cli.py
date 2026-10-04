"""Session-owned CLI parsers and execution.

The compatibility entrypoint supplies an explicit dependency object. Its
contents preserve the long-standing xueness.cli monkeypatch seams without
making this plugin depend on the CLI module during import.
"""
import argparse
import json
import os
import shlex
import sys
from contextlib import ExitStack
from pathlib import Path
from types import FunctionType

from ...core import MODES, Gate, Store, answer_session, run, session_events, append_user_turn
from ...core import parse_disallow_list
from ...plugins import activate
from ... import plugin_sdk
from ... import commands as commands_module
from ... import plugin_runtime, operator_cli, provider_config, providers_api
from ...memory import load as load_memory
from ...cli_interrupt import RunInterrupt
from ...cli_input import capture_clipboard_image, enqueue, multiline, snapshot
from ...session_lease import lease
from ...task_registry import TaskRegistry

def _render_event(ev, file=None, language="zh", stream_state=None) -> None:
    """One live-event line on stderr; vocabulary mirrors session_events.

    stdout stays reserved for the machine-readable summary, so piping ``run
    --output-format json`` keeps working while a human watches stderr.
    """
    out = file or sys.stderr
    t = ev.get("type")
    if t == "assistant_delta":
        delta = ev.get("text") or ""
        if stream_state is not None:
            stream_state["text"] = stream_state.get("text", "") + delta
        if delta:
            print(delta, end="", file=out, flush=True)
    elif t == "assistant":
        text = (ev.get("text") or "").strip()
        if text:
            streamed = stream_state.pop("text", None) if stream_state is not None else None
            if streamed is None:
                print(f"\n\u25c6 {text}", file=out)
            else:
                remainder = text[len(streamed):] if text.startswith(streamed) else ""
                print(remainder, file=out)
    elif t == "tool_call":
        subject = (ev.get("subject") or "").strip()
        print(f"\u2192 {ev.get('name', '')} {subject}".rstrip(), file=out)
    elif t == "tool_result":
        mark = "\u2713" if ev.get("ok") else "\u2717"
        err = ev.get("error") or ""
        label = ev.get("name") or ev.get("subject") or ""
        line = f"{mark} {label}".rstrip()
        if err and not ev.get("ok"):
            line += f" \u2014 {err}"
        print(line, file=out)
    elif t == "completion":
        mark = "\u2713" if ev.get("verified") else "\u26a0"
        summary = (ev.get("summary") or "").strip()
        delivery = ev.get("delivery_status", "not_assessed")
        if language == "en":
            tool_label = 'tool evidence passed' if ev.get('verified') else 'tool evidence needs review'
            delivery_label = {'passed': 'delivery checks passed', 'failed': 'delivery checks failed'}.get(delivery, 'delivery not assessed')
            print(f"{mark} Run ended ({tool_label}; {delivery_label}){': ' + summary if summary else ''}", file=out)
        else:
            tool_label = '工具成功证据通过' if ev.get('verified') else '工具证据待审核'
            delivery_label = {'passed': '交付检查通过', 'failed': '交付检查未通过'}.get(delivery, '交付内容尚未检查')
            print(f"{mark} 运行结束（{tool_label}；{delivery_label}）{': ' + summary if summary else ''}", file=out)
    elif t == "status":
        line = (f"== {ev.get('status')} ({ev.get('steps', 0)} steps)" if language == "en"
                else f"== {ev.get('status')} (\u5171 {ev.get('steps', 0)} \u6b65)")
        if ev.get("question"):
            question_label = 'Question' if language == 'en' else '\u95ee\u9898'
            line += f"\n   {question_label}: {ev['question']}"
        print(line, file=out)

def _add_agent_flags(parser):
    """Session-agent flags shared by ``run`` and ``chat``."""
    parser.add_argument("--provider-id", help="saved provider profile id")
    parser.add_argument("--model", help="override model for this session")
    parser.add_argument("--reasoning-effort", choices=providers_api.REASONING_LEVELS,
                        default=None, help="provider-declared reasoning effort")
    parser.add_argument('--runtime-profile', choices=('standard', 'lightweight'), default=None,
                        help='small-context local model runtime (saved with the session)')
    parser.add_argument('--lightweight', dest='runtime_profile', action='store_const', const='lightweight',
                        help='enable the lightweight local-model runtime')
    parser.add_argument("--max-wall-seconds", type=float, default=None, help="cooperative run time budget, at most 3600 seconds")
    parser.add_argument("--allow-write", action="store_true", help="approve all writes in workspace for this invocation")
    parser.add_argument("--allow-exec", action="store_true", help="approve all subprocesses for this invocation")
    parser.add_argument("--allow-network", action="store_true", help="approve network search/fetch tools for this invocation")
    parser.add_argument("--allow-edit", action="store_true", help="approve all edits in workspace for this invocation (default follows --allow-write)")
    parser.add_argument("--interactive", action="store_true", help="prompt for each write/edit/exec")
    parser.add_argument("--mode", choices=list(MODES), default=None,
                        help="plan denies write/edit/exec before any approval lookup; build keeps deny-by-default")
    parser.add_argument("--disallow-tools", default="",
                        help="comma-separated tool deny list, e.g. 'exec,edit'; denied even with --allow-write/--allow-exec")
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--max-chars", type=int, default=24000)
    parser.add_argument("--max-tokens", type=int, default=None,
                        help="standard: advisory chars/4 estimate; lightweight: input estimate budget; neither calls a model")
    parser.add_argument("--memory-root", type=Path, default=None,
                        help="read-only dsh-grok-memory root; inject curated MEMORY.md/USER.md/KEY.md tracks as untrusted data")
    parser.add_argument("--skill-catalog", action="store_true", help="load skill descriptions first; expose bounded skill_read on demand")
    parser.add_argument("--inject-skills", action="store_true",
                        help="inject enabled skills from <state>/resources/skills as untrusted context")
    parser.add_argument("--allow-hooks", action="store_true",
                        help="run enabled PreToolUse/PostToolUse/SessionStart/Stop hooks (executes commands)")
    parser.add_argument("--allow-mcp", action="store_true",
                        help="connect enabled stdio MCP servers, expose their tools, and approve those "
                             "calls for this invocation (spawns processes; the web UI instead requires "
                             "one approval per call)")
    parser.add_argument("--allow-subagents", action="store_true",
                        help="expose the read-only task tool so the model can delegate sub-tasks")
    parser.add_argument("--grant-plugin-capability", action="append", default=[],
                        choices=plugin_sdk.CAPABILITIES,
                        help="grant a stored plugin manifest the named power (repeatable): "
                             "command / network / filesystem-write")
    parser.add_argument("--target", default=None, metavar="TEXT",
                        help="persistent session goal owned by the planning plugin: injected before every "
                             "model request and verified when the run claims completion")
    parser.add_argument("--target-replace", action="store_true",
                        help="replace the session's existing goal; without it --target refuses to overwrite")

def _apply_cli_target(args, parser, store, session):
    """Hand ``--target`` to planning, then persist it with the session."""
    text = getattr(args, "target", None)
    if text is None:
        return
    state_dir = getattr(args, "state", None)
    planning = (plugin_runtime.entrypoint("planning")
                if plugin_runtime.is_enabled(state_dir, "planning") else None)
    apply_goal = getattr(planning, "apply_session_goal", None) if planning else None
    if not callable(apply_goal):
        parser.error("插件已禁用或依赖不可用: planning")
    try:
        apply_goal(session, text, state_dir=state_dir,
                   replace=getattr(args, "target_replace", False), source="cli")
    except ValueError as exc:
        parser.error(str(exc))
    store.save(session)

def _model_selection_record(provider_id, model, reasoning_effort):
    selection = {"provider_id": provider_id, "model": model}
    if reasoning_effort is not None:
        selection["reasoning_effort"] = reasoning_effort
    return selection

def _prepare_agent(args, parser, store, session):
    """Provider + memory + plugin plan + Gate, wired once for run and chat.

    The capability wiring is the same seam the web layer uses; hand-wiring it
    twice is how a fix lands in one caller and misses the other.
    """
    if args.steps < 1 or args.max_chars < 1000:
        parser.error("--steps must be positive and --max-chars >= 1000")
    if args.max_tokens is not None and args.max_tokens < 1:
        parser.error("--max-tokens must be a positive integer")
    try:
        disallowed = parse_disallow_list(args.disallow_tools)
    except ValueError as exc:
        parser.error(str(exc))
    try:
        provider_config.reject_legacy_fake_session(session)
        selection = session.get("model_selection", {})
        pid = args.provider_id or selection.get("provider_id")
        model = args.model or selection.get("model")
        reasoning_effort = args.reasoning_effort or selection.get("reasoning_effort")
        runtime_override = getattr(args, 'runtime_profile', None)
        provider = provider_config.resolve(args.state, pid, model,
                                           reasoning_effort=reasoning_effort,
                                           **({'runtime_profile': runtime_override} if runtime_override is not None else {}))
        from ..providers.lightweight import profile_for
        if runtime_override is None and (pid != selection.get('provider_id') or model != selection.get('model')):
            runtime_override = getattr(provider, 'runtime_profile', 'standard')
        session['runtime_profile'] = profile_for(session, provider, runtime_override)
        if pid or model or reasoning_effort:
            session["model_selection"] = _model_selection_record(pid, model, reasoning_effort)
        if args.max_wall_seconds is not None and not 0 < args.max_wall_seconds <= 3600:
            parser.error("--max-wall-seconds must be greater than zero and at most 3600")
    except ValueError as exc:
        parser.error(str(exc) if provider_config.is_legacy_fake_session(session)
                     else provider_config.configuration_error(exc))
    memory_text = None
    if (getattr(args, "memory_root", None) is not None
            and plugin_runtime.is_enabled(args.state, "memory")):
        if not args.memory_root.is_dir():
            parser.error("--memory-root must be an existing directory")
        # Read-only: load_memory never writes and never follows symlinks out of the root.
        memory_text = load_memory(args.memory_root, Path(session["root"]).resolve()) or None
    # Explicit opt-in list -- deny-by-default stays visible here rather than
    # being hidden inside the loader.
    names = [name for name, flag in (
        ("skills", getattr(args, "inject_skills", False) or getattr(args, "skill_catalog", False)),
        ("hooks", getattr(args, "allow_hooks", False)),
        ("mcp", getattr(args, "allow_mcp", False)),
        ("subagents", getattr(args, "allow_subagents", False)),
    ) if flag]
    plugin_plan = plugin_sdk.plan(args.state, names,
                                  grants=getattr(args, "grant_plugin_capability", None) or ())
    for refusal in plugin_plan.refused:
        print("PLUGIN REFUSED: %s (%s)" % (refusal["name"], refusal["reason"]), file=sys.stderr)
    allow_edit = args.allow_edit if args.allow_edit else args.allow_write
    gate = Gate(Path(session["root"]), args.allow_write, args.allow_exec,
                getattr(args, "interactive", False), mode=args.mode or "build",
                allow_edit=allow_edit, disallow=disallowed,
                allow_mcp=bool(getattr(args, "allow_mcp", False)),
                allow_network=bool(getattr(args, "allow_network", False)),
                approval_prompt=_approval_prompt)
    return provider, gate, plugin_plan.load, memory_text

def _load_commands(state_dir):
    """Custom chat commands are an optional plugin and vanish when disabled."""
    if not plugin_runtime.is_enabled(state_dir, "commands"):
        return []
    return commands_module.load(state_dir)

def _prompt(label: str) -> str:
    """Read one line with the prompt on stderr — stdout stays JSON-only."""
    print(label, end="", file=sys.stderr)
    try:
        return input()
    finally:
        if not sys.stdin.isatty():
            print(file=sys.stderr)

def _approval_prompt(label: str) -> str:
    # EOF is a denial, never an exception that strands an intent mid-run.
    try:
        return _prompt(label)
    except (EOFError, KeyboardInterrupt):
        return ""

CHAT_HELP = """/help               显示帮助与自定义命令
/status             当前会话、工作区、模式与状态
/mode plan|build    切换模式（plan 禁止写入和执行）
/retry              继续当前运行，不添加用户消息
/paste              多行输入，单独一行 /end 提交，/cancel 取消
/attach PATH        暂存工作区 UTF-8 文本文件快照，随下一条输入发送
/paste-image        显式捕获剪贴板 PNG，随下一条输入发送（不会自动读取剪贴板）
/attachments        查看待发送附件
/detach N|all       移除第 N 个或所有待发送附件
/models             列出已保存的模型配置
/model ID [MODEL]   切换供应商/模型；env 使用环境配置
/dwf [list|cancel [runId]|resume <runId>]
                    本会话启动的动态工作流运行
/compact [说明]     立即按预算压缩上下文（不调用模型，原始日志保留）
/expert [status|resume|stop|任务]
                    专家工作流：调研→计划→实现→审查
/exit 或 /quit      保存会话并退出
运行中 Ctrl+C 请求停止；停止后 /retry 继续，或输入新方向。
输入提示处 Ctrl+C 退出；写入/编辑/执行默认逐次询问。"""

CHAT_HELP_EN = """/help               Show help and custom commands
/status             Show session, workspace, mode and status
/mode plan|build    Change mode (plan denies writes and execution)
/retry              Continue the current run without adding a user message
/paste              Enter multiline input; /end submits and /cancel discards
/attach PATH        Queue a workspace UTF-8 text file for the next input
/paste-image        Explicitly capture a clipboard PNG for the next input
/attachments        List queued attachments
/detach N|all       Remove one or all queued attachments
/models             List saved model profiles
/model ID [MODEL]   Switch provider/model; env uses environment config
/dwf [list|cancel [runId]|resume <runId>]
                    Dynamic workflow runs started by this session
/compact [notes]    Compact the context to budget now (no model call; journal kept)
/expert [status|resume|stop|task]
                    Expert workflow: research → plan → implement → review
/exit or /quit      Save the session and exit
Ctrl+C requests a stop while running; use /retry or enter a new direction afterward."""

def _latest_chat(store, root):
    """Most recently saved live session in exactly this canonical workspace."""
    candidates = []
    for path in store.directory.glob("[0-9a-f]" * 32 + ".json"):
        if path.is_symlink():
            continue
        try:
            s = store.load(path.stem)
            if isinstance(s, dict) and s.get("id") == path.stem and Path(s["root"]).resolve() == root:
                candidates.append((path.stat().st_mtime_ns, path.stem, s))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return max(candidates, key=lambda item: item[:2])[2] if candidates else None

def _report_dynamic_runs(args, store, session, argument):
    """Render the workflows plugin's answer to ``/dwf``; the host decides nothing.

    Listing, cancelling and resuming all live in ``workflows.dynamic_runs``, so
    the chat loop only turns that one payload into lines a human can read.
    """
    language = getattr(args, "language", "zh")
    if not plugin_runtime.is_enabled(args.state, "workflows"):
        print("! " + ("workflows plugin is not enabled" if language == "en"
                      else "插件已禁用或依赖不可用: workflows"), file=sys.stderr)
        return
    handler = getattr(plugin_runtime.entrypoint("workflows"), "dynamic_runs_command", None)
    if not callable(handler):
        return
    try:
        result = handler(args.state, store, session, argument)
    except ValueError as exc:
        # A refusal is an answer: reason plus detail, the same pair CLI and HTTP give.
        payload = exc.payload() if hasattr(exc, "payload") else None
        refusal = (payload or {}).get("refusal") or {"reason": "invalid", "detail": str(exc)}
        print(f"! {refusal['reason']}: {refusal['detail']}", file=sys.stderr)
        return
    runs = result.get("runs")
    if runs is None:
        run = result.get("run") or {}
        if result.get("action") == "cancel":
            label = "Cancelled" if language == "en" else "已取消"
        else:
            label = "Resumed" if language == "en" else "已恢复"
        print(f"{label} {run.get('name', '')} · {run.get('status', '')}".rstrip(" ·"), file=sys.stderr)
        return
    if not runs:
        print("（该会话没有动态工作流运行）" if language == "zh" else "(no dynamic workflow runs)", file=sys.stderr)
        return
    for run in runs:
        state = run.get("resumeRefusal") or {}
        mark = "✓" if run.get("resumable") else "✗"
        line = (f"- {run['id'][:8]} {run.get('name', '')} · {run.get('status')}"
                f" · {run.get('startedAt')} → {run.get('updatedAt')} · {mark}")
        if not run.get("resumable") and state.get("reason"):
            line += f" ({state['reason']})"
        print(line, file=sys.stderr)
    summary = (f"{len(runs)} runs · {result.get('inFlight', 0)} in flight · "
               f"{result.get('resumable', 0)} resumable" if language == "en" else
               f"共 {len(runs)} 个运行 · 进行中 {result.get('inFlight', 0)} · 可恢复 {result.get('resumable', 0)}")
    print(summary + " · /dwf cancel [runId] · /dwf resume <runId>", file=sys.stderr)

def _report_compaction(args, store, session, argument):
    """Hand ``/compact`` to this plugin's compaction face and render the answer.

    Returns the reloaded session, because the compaction rewrote the journal this
    loop is holding; ``None`` when there was nothing to reload.
    """
    language = getattr(args, "language", "zh")
    if not isinstance(session, dict):
        print("! " + ("no session to compact yet" if language == "en"
                      else "还没有可压缩的会话"), file=sys.stderr)
        return None
    from .manual_compact import CompactError, chat
    try:
        report = chat(store, session, argument, state_dir=args.state)
    except CompactError as exc:
        print(f"! {exc.reason}: {exc.detail}", file=sys.stderr)
        return store.load(session["id"])
    if not report.get("compacted"):
        note = ("nothing to compact: the window is already inside its budget"
                if language == "en" else "上下文已在预算内，无需压缩")
        print(f"== {note}", file=sys.stderr)
    else:
        before, after = report["before"], report["after"]
        print((f"Compacted: {before['messages']} → {after['messages']} messages, "
               f"{before['chars']} → {after['chars']} chars, budget {report['budget']}, "
               f"dropped {report['dropped']}, masked {report['masked']}" if language == "en" else
               f"已压缩：消息 {before['messages']} → {after['messages']} 条，"
               f"{before['chars']} → {after['chars']} 字符，预算 {report['budget']}，"
               f"归档 {report['dropped']} 条、遮蔽 {report['masked']} 条（原始日志与全部用户发言保留）"),
              file=sys.stderr)
    return store.load(session["id"])


def _chat_loop(args, parser, store, session):
    try:
        with ExitStack() as owned:
            if session:
                owned.enter_context(lease(store, session['id']))
                session = store.load(session['id'])
            return _chat_loop_owned(args, parser, store, session, owned)
    except BlockingIOError:
        parser.error('session is in use by another process')

def _chat_loop_owned(args, parser, store, session, owned):
    """Lazy session creation and a shared run path for prompts, answers and retry."""
    s = session
    root = Path(s["root"]).resolve() if s else (args.root or Path.cwd()).resolve()
    if not root.is_dir():
        parser.error("chat workspace must be an existing directory")
    # Resuming a plan must not silently grant build-mode capabilities.
    args.mode = args.mode or (s.get("mode", "build") if s else "build")
    if getattr(args, "language", "zh") == "en":
        print(f"Xueness · workspace {root} · mode {args.mode} · /help", file=sys.stderr)
    else:
        print(f"Xueness · root {root} · mode {args.mode} · /help", file=sys.stderr)
    if s:
        _apply_cli_target(args, parser, store, s)
        print(f"chat {s['id']} · {s['status']}", file=sys.stderr)
    provider = gate = names = memory_text = None
    attachments = []
    try:
        for name in args.attach:
            enqueue(attachments, snapshot(root, name))
    except (OSError, ValueError) as exc:
        parser.error(f"无法添加附件: {exc}")
    while True:
        awaiting = s and s.get("status") == "awaiting_user" and s.get("pending_question")
        if awaiting:
            label = "Question" if getattr(args, "language", "zh") == "en" else "问题"
            print(f"\n{label}: {s['pending_question']}", file=sys.stderr)
        try:
            prompt = ("Answer > " if awaiting else "> ") if getattr(args, "language", "zh") == "en" else ("回答 › " if awaiting else "› ")
            text = _prompt(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not text:
            continue
        if text in ("/exit", "/quit"):
            break
        parts = text.split(maxsplit=1)
        command, argument = parts[0], parts[1] if len(parts) > 1 else ""
        literal = False
        if command == "/paste-image":
            try:
                if argument:
                    raise ValueError("/paste-image takes no arguments")
                item = capture_clipboard_image(root)
                enqueue(attachments, item)
                message = (f"Clipboard PNG queued ({item.size} bytes, sha256 {item.sha256[:12]})."
                           if getattr(args, "language", "zh") == "en" else
                           f"已暂存剪贴板 PNG（{item.size} bytes，SHA-256 {item.sha256[:12]}）。")
                print(message, file=sys.stderr)
            except (OSError, ValueError) as exc:
                prefix = "! Clipboard image unavailable: " if getattr(args, "language", "zh") == "en" else "! 剪贴板图片不可用："
                print(prefix + str(exc), file=sys.stderr)
            continue
        if command == "/paste":
            print("多行输入：/end 提交，/cancel 或 Ctrl+C 取消；\\/end 输入字面 /end。", file=sys.stderr)
            try:
                text = multiline(_prompt)
            except EOFError:
                break
            except ValueError as exc:
                print(f"! {exc}", file=sys.stderr)
                continue
            if text is None or not text.strip():
                print("多行输入未提交，附件队列保留。", file=sys.stderr)
                continue
            literal = True
            command = ""
        if command in ("/attach", "/attachments", "/detach"):
            try:
                if command == "/attach":
                    paths = shlex.split(argument)
                    if len(paths) != 1:
                        raise ValueError('用法: /attach "path with spaces.txt"')
                    item = snapshot(root, paths[0])
                    enqueue(attachments, item)
                    print(f"已暂存 {json.dumps(item.path, ensure_ascii=False)}（{item.size} bytes），随下一条输入发送。", file=sys.stderr)
                elif command == "/detach":
                    if argument == "all":
                        attachments.clear()
                    elif argument.isdecimal() and 1 <= int(argument) <= len(attachments):
                        attachments.pop(int(argument) - 1)
                    else:
                        raise ValueError("用法: /detach N|all（N 为附件序号）")
                else:
                    print(json.dumps([{ "index": i, **item.metadata()}
                                      for i, item in enumerate(attachments, 1)], ensure_ascii=False), file=sys.stderr)
            except (OSError, ValueError) as exc:
                print(f"! 无法更新附件: {exc}", file=sys.stderr)
            continue
        if command == "/help":
            print(CHAT_HELP_EN if getattr(args, "language", "zh") == "en" else CHAT_HELP, file=sys.stderr)
            for item in _load_commands(args.state):
                print(f"/{item['id']}  {item.get('description', '')}", file=sys.stderr)
            continue
        if command in ("/models", "/model"):
            if not argument:
                print(json.dumps(providers_api._list({"state_dir": args.state}), ensure_ascii=False), file=sys.stderr)
                continue
            try:
                values = shlex.split(argument)
                if len(values) not in (1, 2):
                    raise ValueError("用法: /model ID [MODEL]")
                pid = None if values[0] == "env" else values[0]
                model = values[1] if len(values) == 2 else None
                next_provider = provider_config.resolve(args.state, pid, model,
                                                        reasoning_effort=args.reasoning_effort,
                                                        **({'runtime_profile': args.runtime_profile} if args.runtime_profile is not None else {}))
                args.provider_id, args.model = pid, model
                if s:
                    s["model_selection"] = _model_selection_record(
                        pid, model, args.reasoning_effort)
                    s['runtime_profile'] = args.runtime_profile or getattr(next_provider, 'runtime_profile', 'standard')
                    store.save(s)
                provider = next_provider if gate else None
                print(f"模型已切换: {values[0]} {model or ''}", file=sys.stderr)
            except ValueError as exc:
                print(f"! {exc}", file=sys.stderr)
            continue
        if command == "/status":
            print(json.dumps({"id": s["id"] if s else None, "root": str(root),
                              "mode": args.mode, "status": s["status"] if s else "new",
                              "steps": s.get("steps", 0) if s else 0}, ensure_ascii=False), file=sys.stderr)
            continue
        if command == "/mode":
            if argument.strip() not in MODES:
                print("用法: /mode plan|build", file=sys.stderr)
                continue
            args.mode = argument.strip()
            if gate:
                gate.mode = args.mode
            if s:
                s["mode"] = args.mode
                s.setdefault("mode_history", []).append({"mode": args.mode, "steps": s.get("steps", 0)})
                store.save(s)
            print(f"mode: {args.mode}", file=sys.stderr)
            continue
        if command == "/dwf":
            _report_dynamic_runs(args, store, s, argument)
            continue
        if command == "/compact":
            refreshed = _report_compaction(args, store, s, argument)
            if refreshed is not None:
                s = refreshed
            continue
        if command.startswith('/') and not literal:
            # Generic plugin-owned slash routing (same manifest commands as the
            # CLI). None means no plugin claims the name; text then flows on.
            try:
                reply = plugin_runtime.dispatch_slash(
                    text, {"state_dir": args.state, "session": s,
                           "store": store, "root": str(root)})
            except (LookupError, OSError, ValueError) as exc:
                print(f"! {exc}", file=sys.stderr)
                continue
            if reply is not None:
                print(reply, file=sys.stderr)
                continue
        retry = not literal and text == "/retry"
        if retry and attachments:
            print("! 附件尚未发送：请输入任务/回答，或 /detach all 后重试", file=sys.stderr)
            continue
        if retry and (not s or awaiting):
            print("! 请先输入任务或回答当前问题", file=sys.stderr)
            continue
        if not retry and len(text) > 5000:
            print("! 输入需为 1..5000 字符", file=sys.stderr)
            continue
        if provider is None:
            # Validate provider/options before writing the first journal.
            provider, gate, names, memory_text = _prepare_agent(
                args, parser, store, s or {"root": str(root)})
        command_items = [] if literal else _load_commands(args.state)
        try:
            if awaiting:
                s = answer_session(store.load(s["id"]), store, text, attachments=attachments, preserve_whitespace=literal)
                print(f"== 已回答，状态 {s['status']}", file=sys.stderr)
            elif not s:
                content, invocation = commands_module.expand(command_items, text)
                s = store.new(content, root, attachments=attachments)
                owned.enter_context(lease(store, s["id"]))
                _apply_cli_target(args, parser, store, s)
                if args.provider_id or args.model or args.reasoning_effort:
                    s["model_selection"] = _model_selection_record(
                        args.provider_id, args.model, args.reasoning_effort)
                    store.save(s)
                if invocation:
                    s["command_invocations"] = [invocation]
                    store.save(s)
                print(f"chat {s['id']}", file=sys.stderr)
            elif not retry:
                s = append_user_turn(store.load(s["id"]), store, text, commands=command_items,
                                     attachments=attachments, preserve_whitespace=literal)
        except (LookupError, ValueError) as exc:
            print(f"! 无法提交输入: {exc}", file=sys.stderr)
            continue
        attachments.clear()
        s["skill_catalog"] = args.skill_catalog
        store.save(s)
        with RunInterrupt(gate) as interrupt, activate(names, args.state, root, s) as ext:
            s = run(store.load(s["id"]), store, provider, gate,
                    args.steps, args.max_chars, memory_text, args.max_tokens,
                    skills=ext.kwargs.get("skills"), skill_reader=ext.kwargs.get("skill_reader"),
                    hooks=ext.kwargs.get("hooks"),
                    mcp_tools=ext.kwargs.get("mcp_tools"),
                    mcp_call=ext.kwargs.get("mcp_call"),
                    subagents=ext.kwargs.get("subagents"),
                    on_event=_event_renderer(getattr(args, "language", "zh")), should_stop=interrupt.should_stop,
                    max_wall_seconds=args.max_wall_seconds, registry=TaskRegistry(),
                    runtime_profile=getattr(args, 'runtime_profile', None))
        if getattr(args, "language", "zh") == "en":
            print(f"== {s['status']} ({s['steps']} steps) · enter a follow-up, /retry to continue, /exit to leave", file=sys.stderr)
        else:
            print(f"== {s['status']}（共 {s['steps']} 步） · 继续输入追问，/retry 继续，/exit 退出", file=sys.stderr)
    return store.load(s["id"]) if s else None

def _print_summary(s, json_mode):
    if json_mode:
        from ...web import pending_denials
        print(json.dumps({"id": s["id"], "status": s["status"], "steps": s["steps"],
                           "mode": s.get("mode", "build"), "completion": s["completion"],
                           "pending": pending_denials(s),
                           "pending_question": s.get("pending_question")}, ensure_ascii=False))
    else:
        print(json.dumps({"id": s["id"], "status": s["status"], "steps": s["steps"], "mode": s.get("mode", "build"), "completion": s["completion"],
                           "pending_question": s.get("pending_question")}, ensure_ascii=False, indent=2))

def _stream_json_event(ev) -> None:
    """One JSON line per live event on stdout (programmatic consumption)."""
    print(json.dumps(ev, ensure_ascii=False))

def _event_renderer(language="zh"):
    state = {}
    return lambda event: _render_event(event, language=language, stream_state=state)

def _register_session_cli(commands):
    """Parser contributions owned by the sessions feature."""
    new = commands.add_parser("new", help="create task and session")
    new.add_argument("task")
    new.add_argument("--root", type=Path, required=True)
    start = commands.add_parser("run", help="resume a session (or create+run one-shot with --prompt)")
    start.add_argument("id", nargs="?", default=None, help="session id to resume")
    start.add_argument("--resume", "--continue", dest="resume", action="store_true",
                       help="explicit resume alias for the positional id (identical behaviour, for scripting clarity)")
    start.add_argument("--prompt", default=None,
                       help="one-shot mode: create a new session for this task under --root, then run it")
    start.add_argument("--attach", action="append", default=[], metavar="PATH",
                       help="attach a workspace text/image/PDF/video file to --prompt (repeatable)")
    start.add_argument("--root", type=Path, default=None,
                       help="workspace root; required with --prompt, ignored with an explicit id")
    start.add_argument("--output-format", choices=("text", "json", "stream-json"), default="text",
                       help="text: pretty JSON summary (default); json: machine-readable {id,status,steps,mode,completion,pending}; "
                            "stream-json: one JSON line per live event, final line type==summary")
    _add_agent_flags(start)
    start.add_argument("--stream", action="store_true",
                       help="print live tool/status events to stderr (stdout summary unchanged)")
    chat = commands.add_parser("chat", help="interactive multi-turn session: type a message, watch steps stream, approve inline")
    chat.add_argument("id", nargs="?", help="session id; omit to start a new conversation")
    chat.add_argument("--attach", action="append", default=[], metavar="PATH",
                      help="queue a workspace text/image/PDF/video file for the next input (repeatable)")
    chat.add_argument("--select", action="store_true", help="choose an existing session interactively")
    chat.add_argument("--search", default="", help="filter --select by title or id")
    chat.add_argument("--root", type=Path, default=None, help="workspace for a new chat or --continue (default cwd)")
    chat.add_argument("--continue", "-c", dest="continue_chat", action="store_true",
                      help="resume the most recently saved live session in this workspace")
    chat.add_argument("--tui", action="store_true", help="use the optional fullscreen terminal interface when available")
    _add_agent_flags(chat)
    chat.set_defaults(interactive=True)
    chat.add_argument("--non-interactive", dest="interactive", action="store_false",
                      help="never prompt for approvals; mutations denied unless explicitly allowed")
    chat.add_argument("--stream", action="store_true", default=True,
                      help="streaming is always on in chat; flag kept for symmetry")
    commands.add_parser("list", help="list local sessions (always JSON output)")
    journal = commands.add_parser("journal", help="export the full session journal (contains prompts/tool output: keep private)")
    journal.add_argument("id")
    answer = commands.add_parser("answer", help="answer an awaiting_user question; session becomes paused")
    answer.add_argument("id")
    answer.add_argument("text")
    show = commands.add_parser("show", help="show one session without full journal")
    show.add_argument("id")
    show.add_argument("--timeline", action="store_true",
                      help="append the derived event timeline (same vocabulary as the web view)")

def _execute_cli_impl(args, parser, store):
    if args.cmd == "sessions":
        from .manual_compact import CompactError
        try:
            result = operator_cli.execute(args, store)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        except CompactError as exc:
            # A refusal keeps its reason and status on stdout, like every other
            # machine-readable answer; the exit code still says "refused".
            print(json.dumps(exc.payload(), ensure_ascii=False, indent=2))
            return 1
        except (OSError, ValueError) as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
    if args.cmd == "new":
        root = args.root.resolve()
        root.mkdir(parents=True, exist_ok=True)
        print(store.new(args.task, root)["id"])
        return 0
    if args.cmd == "list":
        print(json.dumps(store.list(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "show":
        s = store.load(args.id)
        messages = s.get("messages") or []
        token_chars = len(json.dumps(messages, ensure_ascii=False))
        summary = {k: s.get(k) for k in ("id", "task", "root", "status", "steps", "mode", "mode_history", "compactions", "completion", "todos", "pending_question")}
        summary["title"] = (s.get("task") or "")[:80]
        summary["turnCount"] = s.get("steps", 0)
        summary["tokenChars"] = token_chars
        summary["estimatedTokens"] = token_chars // 4
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if args.timeline:
            print("\n--- timeline ---")
            for event in session_events(s):
                _render_event(event, file=sys.stdout, language=getattr(args, "language", "zh"))
        return 0
    if args.cmd == "answer":
        try:
            with lease(store, args.id):
                s = answer_session(store.load(args.id), store, args.text)
        except BlockingIOError:
            parser.error("session is in use by another process")
        except LookupError:
            parser.error("session is not awaiting a user answer")
        except ValueError as exc:
            parser.error(str(exc))
        print(json.dumps({"id": s["id"], "status": s["status"], "pending_question": s.get("pending_question")}, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "journal":
        print("WARNING: full journal contains task text, tool output and model output. Keep it private.", file=sys.stderr)
        print(json.dumps(store.load(args.id), ensure_ascii=False, indent=2))
        return 0
    if args.cmd not in ("run", "chat"):
        return None
    if args.cmd == "run":
        # Validate before creating anything: a rejected flag combination must
        # not leave an orphan session in the journal.
        if args.steps < 1 or args.max_chars < 1000:
            parser.error("--steps must be positive and --max-chars >= 1000")
        if args.max_tokens is not None and args.max_tokens < 1:
            parser.error("--max-tokens must be a positive integer")
        try:
            parse_disallow_list(args.disallow_tools)
        except ValueError as exc:
            parser.error(str(exc))
        prepared_agent = None
        prepared_session = None
        if args.prompt is not None:
            if not args.root:
                parser.error("--prompt requires --root")
            if args.id:
                parser.error("--prompt cannot be combined with a session id")
            prompt_root = args.root.resolve()
            prepared_session = {"root": str(prompt_root)}
            # Validate the model and permissions before any directory/session
            # state is created for a one-shot run.
            prepared_agent = _prepare_agent(args, parser, store, prepared_session)
            prompt_root.mkdir(parents=True, exist_ok=True)
            attachments = []
            try:
                for name in args.attach:
                    enqueue(attachments, snapshot(prompt_root, name))
            except (OSError, ValueError) as exc:
                parser.error(f"无法添加附件: {exc}")
            s = store.new(args.prompt, prompt_root, attachments=attachments)
        else:
            if args.attach:
                parser.error("run --attach requires --prompt; use chat to attach files to an existing session")
            if not args.id:
                parser.error("run needs a session id (or --prompt TASK --root DIR)")
            s = store.load(args.id)
        if args.steps < 1 or args.max_chars < 1000:
            parser.error("--steps must be positive and --max-chars >= 1000")
        if args.max_tokens is not None and args.max_tokens < 1:
            parser.error("--max-tokens must be a positive integer")
        try:
            with lease(store, s["id"]):
                s = store.load(s["id"])
                _apply_cli_target(args, parser, store, s)
                if prepared_agent is None:
                    provider, gate, names, memory_text = _prepare_agent(args, parser, store, s)
                else:
                    provider, gate, names, memory_text = prepared_agent
                    if prepared_session.get("model_selection"):
                        s["model_selection"] = prepared_session["model_selection"]
                s["skill_catalog"] = args.skill_catalog
                store.save(s)
                with RunInterrupt(gate) as interrupt, activate(names, args.state, Path(s["root"]), s) as ext:
                    s = run(s, store, provider, gate,
                            args.steps, args.max_chars, memory_text, args.max_tokens,
                            skills=ext.kwargs.get("skills"), skill_reader=ext.kwargs.get("skill_reader"),
                            hooks=ext.kwargs.get("hooks"),
                            mcp_tools=ext.kwargs.get("mcp_tools"),
                            mcp_call=ext.kwargs.get("mcp_call"),
                            subagents=ext.kwargs.get("subagents"),
                            should_stop=interrupt.should_stop,
                            max_wall_seconds=args.max_wall_seconds,
                            runtime_profile=getattr(args, 'runtime_profile', None),
                            registry=TaskRegistry(),
                            on_event=(lambda ev: _stream_json_event(ev))
                                      if getattr(args, "output_format", "text") == "stream-json"
                                      else (_event_renderer(getattr(args, "language", "zh"))
                                            if getattr(args, "stream", False) else None))
        except BlockingIOError:
            parser.error("session is in use by another process")
    elif args.cmd == "chat":
        if args.select:
            if args.id or args.continue_chat:
                parser.error("--select cannot be combined with ID or --continue")
            options = operator_cli.list_sessions(store, root=args.root, search=args.search)
            for i, item in enumerate(options, 1):
                print(f"{i}. {json.dumps(item['title'], ensure_ascii=False)} · {item['id']} · {item['root']}", file=sys.stderr)
            if not options:
                parser.error("no matching session")
            try:
                choice = _prompt("会话序号（空行取消） › ").strip()
                if not choice:
                    return 0
                if not choice.isdecimal() or not 1 <= int(choice) <= len(options):
                    parser.error("invalid session selection")
                args.id, args.root = options[int(choice)-1]['id'], None
            except (EOFError, KeyboardInterrupt):
                return 0
        if args.id and (args.continue_chat or args.root is not None):
            parser.error("chat ID cannot be combined with --continue or --root")
        # Validate even when the user exits without sending a prompt.
        if args.steps < 1 or args.max_chars < 1000 or (args.max_tokens is not None and args.max_tokens < 1):
            parser.error("--steps/--max-tokens must be positive and --max-chars >= 1000")
        try:
            parse_disallow_list(args.disallow_tools)
            s = store.load(args.id) if args.id else None
        except (OSError, ValueError):
            parser.error("invalid session or tool deny list")
        if args.continue_chat:
            s = _latest_chat(store, (args.root or Path.cwd()).resolve())
            if s is None:
                parser.error("no live session in this workspace; use chat to start one")
    if args.cmd == "chat":
        if getattr(args, "tui", False):
            try:
                from .cli_tui import run_fullscreen
                used, result = run_fullscreen(lambda: _chat_loop(args, parser, store, s),
                                              language=getattr(args, "language", "zh"))
            except ImportError:
                used, result = False, None
            if used:
                s = result
            else:
                fallback = ("全屏终端不可用，改用行式界面。" if getattr(args, "language", "zh") == "zh"
                            else "Fullscreen terminal unavailable; using the line interface.")
                print(fallback, file=sys.stderr)
                s = _chat_loop(args, parser, store, s)
        else:
            s = _chat_loop(args, parser, store, s)
        if s is not None:
            _print_summary(s, json_mode=False)
        return 0
    if s.get("status") == "awaiting_user" and s.get("pending_question"):
        print("AWAITING USER: " + s["pending_question"], file=sys.stderr)
    if args.cmd == "run" and getattr(args, "output_format", "text") == "stream-json":
        from ...web import pending_denials
        print(json.dumps({"type": "summary", "id": s["id"], "status": s["status"], "steps": s["steps"],
                           "mode": s.get("mode", "build"), "completion": s["completion"],
                           "pending": pending_denials(s),
                           "pending_question": s.get("pending_question")}, ensure_ascii=False))
    elif args.cmd == "run" and getattr(args, "output_format", "text") == "json":
        _print_summary(s, json_mode=True)
    else:
        _print_summary(s, json_mode=False)
    return 0 if s["status"] == "completed" else 2

def _bound_namespace(deps):
    """Bind implementation helpers to this invocation's explicit dependencies."""
    namespace = dict(globals())
    values = vars(deps) if hasattr(deps, "__dict__") else (dict(deps) if deps else {})
    namespace.update(values)
    internal = {
        "_render_event", "_add_agent_flags", "_model_selection_record", "_prepare_agent",
        "_load_commands", "_prompt", "_approval_prompt", "_latest_chat", "_chat_loop",
        "_chat_loop_owned", "_print_summary", "_stream_json_event", "_event_renderer",
        "_execute_cli_impl",
    }
    # Compatibility wrappers supplied by xueness.cli take precedence where
    # callers historically monkeypatched them. Everything else is bound to
    # isolated copies that share the same dependency namespace.
    for name in internal:
        if name in values:
            continue
        original = globals()[name]
        bound_function = FunctionType(original.__code__, namespace, name,
                                      original.__defaults__, original.__closure__)
        bound_function.__kwdefaults__ = original.__kwdefaults__
        namespace[name] = bound_function
    return namespace


def add_parsers(commands):
    _register_session_cli(commands)


def add_agent_flags(parser):
    return _add_agent_flags(parser)


def _invoke_helper(name, *args, deps=None, **kwargs):
    values = vars(deps) if hasattr(deps, "__dict__") else (dict(deps) if deps else {})
    values = dict(values)
    # The root compatibility wrapper delegates back to this package. Exclude
    # that one name while invoking its implementation to avoid a cycle.
    values.pop(name, None)
    bound = _bound_namespace(values)
    return bound[name](*args, **kwargs)


def prepare_agent(args, parser, store, session, deps=None):
    return _invoke_helper("_prepare_agent", args, parser, store, session, deps=deps)


def load_commands(state_dir, deps=None):
    return _invoke_helper("_load_commands", state_dir, deps=deps)


def prompt(label, deps=None):
    return _invoke_helper("_prompt", label, deps=deps)


def approval_prompt(label, deps=None):
    return _invoke_helper("_approval_prompt", label, deps=deps)


def latest_chat(store, root, deps=None):
    return _invoke_helper("_latest_chat", store, root, deps=deps)


def chat_loop(args, parser, store, session, deps=None):
    return _invoke_helper("_chat_loop", args, parser, store, session, deps=deps)


def print_summary(session, json_mode, deps=None):
    return _invoke_helper("_print_summary", session, json_mode, deps=deps)


def render_event(event, deps=None, **kwargs):
    return _invoke_helper("_render_event", event, deps=deps, **kwargs)


def stream_json_event(event, deps=None):
    return _invoke_helper("_stream_json_event", event, deps=deps)


def event_renderer(language="zh", deps=None):
    return _invoke_helper("_event_renderer", language, deps=deps)


def chat_loop_owned(args, parser, store, session, owned, deps=None):
    return _invoke_helper("_chat_loop_owned", args, parser, store, session, owned, deps=deps)


def execute_cli(args, deps=None):
    values = vars(deps) if hasattr(deps, "__dict__") else (dict(deps) if deps else {})
    parser = values.get("parser")
    if parser is None:
        parser = argparse.ArgumentParser(prog="xueness")
    store_factory = values.get("Store", Store)
    if args.cmd == "new":
        Path(args.root).resolve().mkdir(parents=True, exist_ok=True)
    store = store_factory(args.state)
    bound = _bound_namespace(deps)
    execute = FunctionType(_execute_cli_impl.__code__, bound, "_execute_cli_impl",
                           _execute_cli_impl.__defaults__, _execute_cli_impl.__closure__)
    execute.__kwdefaults__ = _execute_cli_impl.__kwdefaults__
    return execute(args, parser, store)
