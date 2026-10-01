"""Session planning tools contributed by the planning plugin."""
from __future__ import annotations
from ...tool_contract import BuiltinTool
MAX_TODO_ITEMS = 50
TODO_STATUSES = ("pending", "in_progress", "done")

def normalize_todos(value) -> list:
    """Validate a session-scoped todo list; no filesystem access, capped."""
    if not isinstance(value, list):
        raise ValueError("todos must be an array")
    if len(value) > MAX_TODO_ITEMS:
        raise ValueError(f"todos capped at {MAX_TODO_ITEMS} items")
    seen: set = set()
    out: list = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("each todo must be an object")
        tid = item.get("id")
        text = item.get("text")
        status = item.get("status", "pending")
        if not isinstance(tid, str) or not tid.strip() or len(tid) > 64:
            raise ValueError("todo id must be a 1..64 character string")
        if tid in seen:
            raise ValueError("duplicate todo id")
        seen.add(tid)
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise ValueError("todo text must be 1..2000 characters")
        if status not in TODO_STATUSES:
            raise ValueError(f"todo status must be one of {', '.join(TODO_STATUSES)}")
        out.append({"id": tid, "text": text.strip(), "status": status})
    return out


def _todo_read(root, gate, args, session, call_id) -> dict:
    gate.check("todo_read", "")
    todos = (session or {}).get("todos", [])
    return {"ok": True, "todos": list(todos) if isinstance(todos, list) else []}


def _todo_write(root, gate, args, session, call_id) -> dict:
    gate.check("todo_write", "")
    if session is None:
        raise ValueError("todo_write needs a session")
    todos = normalize_todos(args.get("todos"))
    session["todos"] = todos
    return {"ok": True, "todos": todos, "count": len(todos)}


def _ask_user(root, gate, args, session, call_id) -> dict:
    # Validate here; the run loop pauses the session on awaiting_user.
    gate.check("ask_user", "")
    question = args.get("question")
    if not isinstance(question, str) or not question.strip() or len(question) > 2000:
        raise ValueError("question must be 1..2000 characters")
    return {"ok": True, "awaiting_user": True, "question": question.strip()}


REGISTRY: tuple[BuiltinTool, ...] = (
    BuiltinTool("todo_read", "Read the session-scoped todo list (no filesystem access)",
                {}, (), "todo_read", False, _todo_read),
    BuiltinTool("todo_write", "Replace the session-scoped todo list (journal-persisted, capped)",
                {"todos": {"type": "array", "items": {"type": "object"}}}, ("todos",),
                "todo_write", False, _todo_write),
    BuiltinTool("ask_user", "Ask the operator a question; pauses the run until answered",
                {"question": {"type": "string"}}, ("question",), "ask_user", False, _ask_user),
)
