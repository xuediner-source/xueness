"""Model-facing workflow and background-job tools.

Plans are strict JSON DAGs. No Python/JavaScript expressions are evaluated.
Starting a workflow or command is an exec-gated action tied to the exact
journaled arguments, so a denied call can only be replayed after operator
approval of that same action.
"""
from __future__ import annotations

import json
from pathlib import Path

from ...tool_contract import BuiltinTool, execution_context
from .dynamic_runs import owner_session_id
from .workflows import WorkflowStore


def _store():
    context = execution_context()
    return WorkflowStore(context["state_dir"])


def _subject(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _run_subject(args):
    return _subject({"workflow_id": args["workflow_id"], "approved": True,
                     "allow_real": args.get("allow_real", False),
                     "plan_digest": args["plan_digest"]})


def _background_subject(args):
    return _subject(args["argv"])


def _cancel_subject(args):
    return _subject(["background_cancel", args["job_id"]])


def _answer_subject(args):
    return _subject(["workflow_answer_actor", args["workflow_id"], args["node_id"], args["answer"]])


def _root(session):
    if not isinstance(session, dict) or not isinstance(session.get("root"), str):
        raise ValueError("workflow tools require an active session")
    root = Path(session["root"]).resolve()
    if not root.is_dir():
        raise ValueError("session workspace is unavailable")
    return root


def _plan(args, root):
    has_plan, has_script = "plan" in args, "script" in args
    if has_plan == has_script:
        raise ValueError("provide exactly one of plan or script")
    if has_plan:
        return args["plan"]
    from .dsl import compile_workflow_script
    return compile_workflow_script(args["script"], root)


def _create(root, gate, args, session, call_id):
    gate.check("planning", "workflow_create", call_id)
    workspace = _root(session)
    row = _store().create(_plan(args, workspace), workspace, args.get("reuse"),
                          owner_session=owner_session_id(session))
    return {"ok": True, "workflow": row}


def _amend(root, gate, args, session, call_id):
    gate.check("planning", "workflow_amend", call_id)
    workspace = _root(session)
    row = _store().amend(args["workflow_id"], _plan(args, workspace), workspace)
    return {"ok": True, "workflow": row}


def _run(root, gate, args, session, call_id):
    store = _store()
    record = store.load(args["workflow_id"])
    if record.get("root") != str(_root(session)):
        raise PermissionError("workflow belongs to another workspace")
    from .workflows import workflow_plan_digest
    digest = workflow_plan_digest(record)
    if args["plan_digest"] != digest:
        raise ValueError("workflow plan changed; inspect status and approve the current digest")
    allow_real = args.get("allow_real", False)
    # The web host's real-provider switch is a hard ceiling, including on
    # model-generated workflow launches. Check before Gate approval so an
    # exec approval cannot turn a host-disabled real-model request into a
    # pending action that later starts a detached worker. The CLI Gate has no
    # host switch; its provider authorization remains governed by its caller.
    if (allow_real and getattr(gate, "web_approval_gate", False)
            and not getattr(gate, "allow_real", False)):
        return {"ok": False, "error": "real provider disabled by host"}
    subject = _run_subject(args)
    gate.check("exec", subject, call_id)
    row = store.launch(args["workflow_id"], approved=True, allow_real=allow_real,
                       expected_digest=digest)
    return {"ok": True, "workflow": row}


def _status(root, gate, args, session, call_id):
    gate.check("planning", "workflow_status", call_id)
    store = _store()
    row = store.load(args["workflow_id"])
    if row.get("root") != str(_root(session)):
        raise PermissionError("workflow belongs to another workspace")
    from .workflows import workflow_plan_digest
    row["plan_digest"] = workflow_plan_digest(row)
    return {"ok": True, "workflow": row}


def _background_exec(root, gate, args, session, call_id):
    argv = args["argv"]
    gate.check("exec", _background_subject(args), call_id)
    root = _root(session)
    timeout = args.get("timeout", 300)
    plan = {"name": args.get("name") or argv[0], "nodes": [{
        "id": "command", "argv": argv, "timeout": timeout,
    }]}
    store = _store()
    created = store.create(plan, root, owner_session=owner_session_id(session))
    row = store.launch(created["id"], approved=True)
    return {"ok": True, "workflow": row}


def _background_status(root, gate, args, session, call_id):
    gate.check("planning", "background_status", call_id)
    row = _store().load(args["job_id"])
    if row.get("root") != str(_root(session)):
        raise PermissionError("job belongs to another workspace")
    return {"ok": True, "job": row}


def _background_cancel(root, gate, args, session, call_id):
    store = _store()
    record = store.load(args["job_id"])
    if record.get("root") != str(_root(session)):
        raise PermissionError("job belongs to another workspace")
    gate.check("exec", _cancel_subject(args), call_id)
    row = store.control(args["job_id"], "cancel")
    return {"ok": True, "job": row}


def _background_logs(root, gate, args, session, call_id):
    gate.check("planning", "background_logs", call_id)
    store = _store()
    if store.load(args["job_id"]).get("root") != str(_root(session)):
        raise PermissionError("job belongs to another workspace")
    return {"ok": True, **store.log(args["job_id"], "command")}


def _answer_actor(root, gate, args, session, call_id):
    store = _store()
    if store.load(args["workflow_id"]).get("root") != str(_root(session)):
        raise PermissionError("workflow belongs to another workspace")
    gate.check("exec", _answer_subject(args), call_id)
    row = store.answer_actor(args["workflow_id"], args["node_id"], args["answer"])
    return {"ok": True, "workflow": row}


def _string(description, maximum=256):
    return {"type": "string", "minLength": 1, "maxLength": maximum,
            "description": description}


REGISTRY = (
    BuiltinTool("workflow_create", "Create a declarative workflow DAG in this session workspace",
                {"plan": {"type": "object", "description": "Literal declarative DAG; exclusive with script"},
                 "script": {"type": "string", "maxLength": 32000,
                            "description": "Safe phase/agent/parallel/pipeline DSL; exclusive with plan"},
                 "reuse": _string("Settled workflow id to reuse unchanged nodes", 32)},
                (), "planning", False, _create),
    BuiltinTool("workflow_amend", "Replace a settled workflow plan; completed work is invalidated",
                {"workflow_id": _string("Workflow id", 32), "plan": {"type": "object"},
                 "script": {"type": "string", "maxLength": 32000}},
                ("workflow_id",), "planning", False, _amend),
    BuiltinTool("workflow_run", "Start an approved workflow; this action requires operator approval",
                {"workflow_id": _string("Workflow id", 32),
                 "allow_real": {"type": "boolean", "description": "Opt in to real model calls by actor nodes"},
                 "plan_digest": _string("Digest returned by workflow_status/create; approval binds to this plan", 64)},
                ("workflow_id", "plan_digest"), "exec", True, _run, _run_subject),
    BuiltinTool("workflow_status", "Inspect workflow state and its bounded event journal",
                {"workflow_id": _string("Workflow id", 32)}, ("workflow_id",),
                "planning", False, _status),
    BuiltinTool("background_exec", "Start a literal argv command as a durable background job; requires operator approval",
                {"argv": {"type": "array", "minItems": 1, "maxItems": 128,
                          "items": {"type": "string", "maxLength": 16000}},
                 "timeout": {"type": "number", "minimum": 0.1, "maximum": 3600},
                 "name": _string("Optional job label", 120)}, ("argv",), "exec", True,
                _background_exec, _background_subject),
    BuiltinTool("background_status", "Inspect a background command job",
                {"job_id": _string("Workflow job id", 32)}, ("job_id",), "planning", False,
                _background_status),
    BuiltinTool("background_cancel", "Request cancellation of a background command job",
                {"job_id": _string("Workflow job id", 32)}, ("job_id",), "exec", True,
                _background_cancel, _cancel_subject),
    BuiltinTool("background_logs", "Read the bounded output tail of a background command job",
                {"job_id": _string("Workflow job id", 32)}, ("job_id",), "planning", False,
                _background_logs),
    BuiltinTool("workflow_answer_actor", "Answer a paused workflow actor and resume its transcript",
                {"workflow_id": _string("Workflow id", 32), "node_id": _string("Actor node id", 64),
                 "answer": _string("Operator answer", 5000)},
                ("workflow_id", "node_id", "answer"), "exec", True, _answer_actor, _answer_subject),
)
