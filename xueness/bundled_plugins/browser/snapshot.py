"""Bounded formatting for the browser accessibility snapshot.

The worker collects Playwright's AI-mode aria tree and may already drop nodes
past the same numeric caps. This module is the boundary the model sees: it
keeps role, accessible name, indentation and interactable refs, and it marks
node and character truncation. It does not launch a browser, import modules
dynamically, or evaluate page script.

A ref is ``e<N>`` or, inside an iframe, ``f<frame>e<N>``. Existing
``browser_click`` / ``browser_fill`` already pass ``selector`` to
``page.locator``, so ``aria-ref=<ref>`` addresses that node until the next
snapshot or navigation. Refs are not a separate action parameter.
"""
from __future__ import annotations

import json
import re

# Keep these numeric caps identical to the SNAPSHOT_MAX_* constants in bridge.mjs.
MAX_SNAPSHOT_NODES = 200
MAX_SNAPSHOT_DEPTH = 24
MAX_SNAPSHOT_NAME = 120
MAX_SNAPSHOT_CHARS = 12_000
MAX_SNAPSHOT_SCAN = 5000

_ROLE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_REF = re.compile(r"^(?:f\d+)?e\d+$")
_MARKER_BUDGET = 96


def format_snapshot(nodes, *, reported_total=None, reported_truncated=False):
    """Return a bounded indented tree for one untrusted aria-node list.

    ``nodes`` must be a list. Anything else is rejected so a worker bug cannot
    pass an unbounded string through as the tool result. Extra fields on a node
    are ignored. A ref that is not the Playwright aria-ref shape is omitted.
    """
    if not isinstance(nodes, list):
        raise ValueError("invalid snapshot")
    lines = []
    used = 0
    kept = 0
    seen = 0
    walked = 0
    node_truncated = False
    char_truncated = False
    scan_hit = False
    stack = []
    for item in reversed(nodes):
        node = _as_node(item)
        if node is not None:
            stack.append((node, 0))
    while stack:
        if walked >= MAX_SNAPSHOT_SCAN:
            scan_hit = True
            node_truncated = True
            break
        node, depth = stack.pop()
        walked += 1
        role, name = _role_and_name(node)
        children = node.get("children")
        children = children if isinstance(children, list) else []
        if not role or (role == "text" and not name):
            # A junk wrapper or blank text node is not a snapshot row. Unwrap
            # one level so its children stay visible, without spending the budget.
            if children and depth < MAX_SNAPSHOT_DEPTH:
                _push_children(stack, children, depth)
            elif children:
                node_truncated = True
            continue
        seen += 1
        over_budget = depth > MAX_SNAPSHOT_DEPTH or kept >= MAX_SNAPSHOT_NODES or char_truncated
        if over_budget:
            node_truncated = True
        else:
            line = _render(role, name, node, depth)
            extra = len(line) + (1 if lines else 0)
            if used + extra > MAX_SNAPSHOT_CHARS:
                char_truncated = True
                node_truncated = True
            else:
                lines.append(line)
                used += extra
                kept += 1
        if not children:
            continue
        if depth >= MAX_SNAPSHOT_DEPTH:
            node_truncated = True
            continue
        # Past the node or character budget, keep walking only to count rows.
        _push_children(stack, children, depth + 1)
    if type(reported_total) is int and 0 <= reported_total <= MAX_SNAPSHOT_SCAN and reported_total > seen:
        seen = reported_total
    if reported_truncated or seen > kept:
        node_truncated = True
    tree, kept, char_truncated = _with_marker(
        lines, node_truncated, char_truncated, seen, scan_hit)
    return {
        "tree": tree,
        "nodeCount": kept,
        "totalNodes": seen,
        "truncated": node_truncated or char_truncated,
        "charTruncated": char_truncated,
    }


def _as_node(value):
    if isinstance(value, str):
        if not value.strip():
            return None
        return {"role": "text", "name": value}
    if isinstance(value, dict):
        return value
    return None


def _push_children(stack, children, depth):
    for child in reversed(children):
        node = _as_node(child)
        if node is not None:
            stack.append((node, depth))


def _clean_name(value):
    if not isinstance(value, str) or not value:
        return ""
    text = re.sub(r"\s+", " ", value[:2000]).strip()
    return text[:MAX_SNAPSHOT_NAME]


def _role_and_name(node):
    role = node.get("role")
    if not isinstance(role, str) or not _ROLE.fullmatch(role):
        role = ""
    name = _clean_name(node.get("name"))
    if not name and role == "text":
        name = _clean_name(node.get("text"))
    if role == "text" and not name:
        return "text", ""
    return role, name


def _render(role, name, node, depth):
    head = role
    if name:
        head += " " + json.dumps(name, ensure_ascii=False)
    flags = []
    ref = node.get("ref")
    if isinstance(ref, str) and _REF.fullmatch(ref):
        flags.append("ref=" + ref)
    if node.get("disabled") is True:
        flags.append("disabled")
    checked = node.get("checked")
    if checked is True:
        flags.append("checked")
    elif checked == "mixed":
        flags.append("checked=mixed")
    level = node.get("level")
    if type(level) is int and 1 <= level <= 9:
        flags.append("level=" + str(level))
    if flags:
        head += "".join(" [" + flag + "]" for flag in flags)
    return ("  " * depth) + "- " + head


def _marker(node_truncated, char_truncated, kept, seen, scan_hit):
    parts = []
    if node_truncated:
        parts.append("node limit")
    if char_truncated:
        parts.append("character limit")
    label = ", ".join(parts) or "limit"
    if node_truncated and seen > kept:
        scope = "at least " + str(seen) if scan_hit else str(seen)
        return "[truncated: " + label + ", kept " + str(kept) + " of " + scope + "]"
    return "[truncated: " + label + "]"


def _with_marker(lines, node_truncated, char_truncated, seen, scan_hit):
    if not node_truncated and not char_truncated:
        return "\n".join(lines), len(lines), False
    while True:
        marker = _marker(node_truncated, char_truncated, len(lines), seen, scan_hit)
        body = lines + [marker]
        tree = "\n".join(body)
        if len(tree) <= MAX_SNAPSHOT_CHARS:
            return tree, len(lines), char_truncated
        if not lines:
            return marker[:MAX_SNAPSHOT_CHARS], 0, True
        lines.pop()
        char_truncated = True
        node_truncated = True
