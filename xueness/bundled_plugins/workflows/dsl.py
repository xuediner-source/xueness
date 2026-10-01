"""Small, non-executable workflow expression language.

Supported forms are Python-shaped declarations using ``phase``, ``agent``,
``parallel`` and ``pipeline``. The source is parsed to an AST and interpreted
from an explicit allowlist; it is never compiled or evaluated as Python.
"""
from __future__ import annotations

import ast


_MAX_SCRIPT = 32_000
_MAX_NODES = 64
_AGENT_KEYS = {"cwd", "timeout", "provider_id", "model", "writable"}


def compile_workflow_script(source, root, default_name="Workflow"):
    if not isinstance(source, str) or not source.strip() or len(source) > _MAX_SCRIPT:
        raise ValueError("workflow script must be 1..32000 characters")
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        raise ValueError("invalid workflow expression syntax") from None

    nodes = []
    names = {}
    current_phase = None
    name = default_name

    def literal(node):
        if isinstance(node, ast.Constant) and (node.value is None or type(node.value) in (str, int, float, bool)):
            return node.value
        if isinstance(node, (ast.List, ast.Tuple)):
            return [literal(item) for item in node.elts]
        if isinstance(node, ast.Dict):
            result = {}
            for key, value in zip(node.keys, node.values):
                item_key = literal(key)
                if not isinstance(item_key, str) or item_key in result:
                    raise ValueError("workflow dictionaries need unique string keys")
                result[item_key] = literal(value)
            return result
        raise ValueError("workflow arguments must be literal values")

    def add_agent(call):
        if len(call.args) != 1 or not isinstance(call.args[0], ast.Constant) or not isinstance(call.args[0].value, str):
            raise ValueError("agent() needs one literal prompt string")
        prompt = call.args[0].value
        kwargs = {}
        for item in call.keywords:
            if item.arg not in _AGENT_KEYS or item.arg in kwargs:
                raise ValueError("agent() has an unsupported or duplicate option")
            kwargs[item.arg] = literal(item.value)
        node_id = f"agent_{len(nodes) + 1:03d}"
        row = {"id": node_id, "kind": "agent", "prompt": prompt, **kwargs}
        if current_phase:
            row["phase"] = current_phase
        nodes.append(row)
        if len(nodes) > _MAX_NODES:
            raise ValueError("workflow has more than 64 agents")
        return [node_id]

    def expression(node):
        if isinstance(node, ast.Await):
            return expression(node.value)
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise ValueError("workflow calls must use a named DSL primitive")
            primitive = node.func.id
            if primitive == "agent":
                return add_agent(node)
            if primitive == "parallel":
                if len(node.args) != 1 or node.keywords or not isinstance(node.args[0], (ast.List, ast.Tuple)):
                    raise ValueError("parallel() accepts one list of agent stages")
                return [item for child in node.args[0].elts for item in expression(child)]
            if primitive == "pipeline":
                if len(node.args) != 1 or node.keywords or not isinstance(node.args[0], (ast.List, ast.Tuple)):
                    raise ValueError("pipeline() accepts one list of sequential stages")
                previous = []
                all_ids = []
                for child in node.args[0].elts:
                    stage = expression(child)
                    for node_id in stage:
                        row = next(item for item in nodes if item["id"] == node_id)
                        row["needs"] = sorted(set(row.get("needs", [])) | set(previous))
                    previous = stage
                    all_ids.extend(stage)
                return all_ids
            if primitive == "phase":
                raise ValueError("phase() is only allowed as a top-level statement")
            raise ValueError("unsupported workflow primitive: " + primitive)
        if isinstance(node, ast.Name):
            if node.id not in names:
                raise ValueError("unknown workflow name: " + node.id)
            return list(names[node.id])
        raise ValueError("workflow expressions may only combine DSL calls and assigned stage names")

    try:
      for statement in tree.body:
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
            call = statement.value
            if isinstance(call.func, ast.Name) and call.func.id == "phase":
                if len(call.args) != 1 or call.keywords:
                    raise ValueError("phase() accepts one literal title")
                title = literal(call.args[0])
                if not isinstance(title, str) or not title.strip() or len(title) > 120:
                    raise ValueError("phase title must be 1..120 characters")
                current_phase = title.strip()
            else:
                expression(call)
            continue
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
            target = statement.targets[0].id
            if target == "name":
                value = literal(statement.value)
                if not isinstance(value, str) or not value.strip() or len(value) > 120:
                    raise ValueError("workflow name must be 1..120 characters")
                name = value.strip()
            else:
                names[target] = expression(statement.value)
            continue
        raise ValueError("workflow scripts only support DSL expressions and simple assignments")
    except RecursionError:
        raise ValueError("workflow DSL nesting is too deep") from None

    if not nodes:
        raise ValueError("workflow script must declare at least one agent")
    return {"name": name, "nodes": nodes}
