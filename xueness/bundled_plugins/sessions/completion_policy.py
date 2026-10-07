"""Sessions-owned policy for deciding when a turn needs tool evidence."""
from __future__ import annotations

import hashlib
import json
import re


_GREETING = re.compile(
    r"^(?:hi|hello|hey|你好|您好|嗨|早上好|晚上好|下午好|早安|晚安|哈喽|在吗)"
    r"(?:\b|[，,！!。．.？?\s]|$)", re.IGNORECASE)

_WORKSPACE_TARGET = re.compile(
    r"\b(?:this|the|my|our)\s+(?:repo(?:sitory)?|workspace|project|codebase|file|folder|directory|branch|app|application)\b"
    r"|\b(?:in|within|inside|against)\s+(?:the\s+)?(?:repo(?:sitory)?|workspace|project|codebase)\b"
    r"|\b(?:src/|tests?/|docs/|[\w.-]+\.(?:py|ts|tsx|js|jsx|json|md|txt|toml|yaml|yml))\b"
    r"|(?:这个|该|当前)(?:仓库|代码库|工作区|项目|文件|目录|分支|应用)"
    r"|(?:仓库|代码库|工作区)|(?:项目|文件|目录)里|(?:附件|附加文件)", re.IGNORECASE)

_WORKSPACE_ACTION = re.compile(
    r"\b(?:implement|fix|debug|refactor|edit|modify|change|update|delete|remove|create|write|read|inspect|review|search|find|test|verify|run|execute|build|deploy|install|commit)\b"
    r"|(?:实现|修复|调试|重构|编辑|修改|更改|更新|删除|移除|创建|写入|读取|查看|检查|审查|搜索|查找|测试|验证|运行|执行|构建|部署|安装|提交)",
    re.IGNORECASE)

_EXPLICIT_ACTION = re.compile(
    r"\b(?:fix\s+(?:the\s+)?(?:bug|issue|error)|run\s+(?:the\s+)?(?:tests?|command|script|server)|execute\s+(?:the\s+)?command|search\s+the\s+web|browse\s+the\s+web|look\s+up\s+(?:the\s+)?(?:latest|current)|research\s+(?:the\s+)?(?:latest|current))\b"
    r"|(?:修复(?:一下)?(?:这个|该)?(?:问题|错误|bug)|运行(?:一下)?(?:测试|命令|脚本)|执行(?:命令|脚本)|联网搜索|搜索网页|查一下最新|研究最新)",
    re.IGNORECASE)

_NETWORK_ACTION = re.compile(
    r"\b(?:search|browse|look\s+up|research|check)\b.{0,50}\b(?:web|internet|online|latest|current|today|price|news|weather)\b"
    r"|(?:搜索|浏览|查询|查找|研究).{0,30}(?:网页|网络|最新|当前|今天|价格|新闻|天气)", re.IGNORECASE)


def _delivery_plan_settled(session: dict) -> bool:
    """A previous successful turn can settle only the exact same checklist."""
    requirements = session.get('delivery_requirements')
    history = session.get('completion_history')
    if not isinstance(requirements, list) or not requirements or not isinstance(history, list) or not history:
        return False
    latest = history[-1]
    if (not isinstance(latest, dict) or latest.get('delivery_status') != 'passed'
            or latest.get('status') not in ('verified', 'not_applicable')):
        return False
    messages = session.get('messages') or []
    current_turn = 'turn-' + str(max(1, sum(1 for row in messages
        if isinstance(row, dict) and row.get('role') == 'user')))
    if latest.get('turn_id') == current_turn or not re.fullmatch(r'turn-[1-9][0-9]*', str(latest.get('turn_id', ''))):
        return False
    try:
        digest = hashlib.sha256(json.dumps(requirements, sort_keys=True, ensure_ascii=True).encode('ascii')).hexdigest()
    except (TypeError, ValueError):
        return False
    return latest.get('delivery_plan_digest') == digest


def requires_evidence(session: dict, call_ids=()) -> bool:
    """Require evidence only for actions that depend on tools or outside state.

    A no-tool response can still be the completed answer to ordinary chat,
    general questions, code explanations, or text-only programming examples.
    """
    if call_ids or (session.get("delivery_requirements") and not _delivery_plan_settled(session)):
        return True
    messages = session.get("messages") or []
    user_text = next((row.get("content", "") for row in reversed(messages)
                      if isinstance(row, dict) and row.get("role") == "user"), "")
    if isinstance(user_text, list):
        user_text = '\n'.join(block['text'] for block in user_text
                              if isinstance(block, dict) and block.get('type') == 'text'
                              and isinstance(block.get('text'), str))
    if not isinstance(user_text, str):
        return False
    text = user_text.strip()
    if not text:
        return False
    if _GREETING.match(text):
        # A longer greeting remains ordinary conversation unless it also asks
        # for an explicit workspace or network action.
        if not (_WORKSPACE_TARGET.search(text) or _NETWORK_ACTION.search(text)
                or _EXPLICIT_ACTION.search(text)):
            return False
    if _NETWORK_ACTION.search(text) or _EXPLICIT_ACTION.search(text):
        return True
    return bool(_WORKSPACE_TARGET.search(text) and _WORKSPACE_ACTION.search(text))
