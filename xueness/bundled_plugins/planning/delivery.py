"""Persisted delivery requirements and deterministic content checks, not self-certification."""
import os
import re
import stat
from pathlib import Path
from urllib.parse import urlsplit
from ...tool_contract import BuiltinTool

MAX_ITEMS = 40
MAX_BYTES = 2_000_000
REPORT_RE = re.compile(r'报告|资料|research|report', re.I)


def _read_bounded_workspace_file(root, requested_path):
    """Read one in-root regular file, refusing symlink traversal where supported."""
    from ..files.builtin_tools import path_in

    root_path = Path(root).resolve()
    target = path_in(root_path, requested_path)
    relative = target.relative_to(root_path)
    if not relative.parts:
        raise ValueError('delivery path is not a file')

    nofollow = getattr(os, 'O_NOFOLLOW', 0)
    directory_flag = getattr(os, 'O_DIRECTORY', 0)
    flags = os.O_RDONLY | nofollow
    if os.open in getattr(os, 'supports_dir_fd', set()):
        descriptors = [os.open(str(root_path), os.O_RDONLY | directory_flag | nofollow)]
        file_fd = None
        try:
            for component in relative.parts[:-1]:
                descriptors.append(os.open(
                    component, os.O_RDONLY | directory_flag | nofollow,
                    dir_fd=descriptors[-1]))
            file_fd = os.open(relative.parts[-1], flags, dir_fd=descriptors[-1])
            if not stat.S_ISREG(os.fstat(file_fd).st_mode):
                raise ValueError('delivery path is not a regular file')
            chunks, total = [], 0
            while True:
                chunk = os.read(file_fd, min(65536, MAX_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError('delivery file too large')
            return b''.join(chunks)
        finally:
            if file_fd is not None:
                os.close(file_fd)
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    # Platforms without openat-style directory handles still reject a final
    # symlink and verify the opened object itself is a regular file.
    file_fd = os.open(str(target), flags)
    try:
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            raise ValueError('delivery path is not a regular file')
        chunks, total = [], 0
        while True:
            chunk = os.read(file_fd, min(65536, MAX_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_BYTES:
                raise ValueError('delivery file too large')
        return b''.join(chunks)
    finally:
        os.close(file_fd)


def seed(session):
    """Carry explicit output filenames from the original request even if no plan is called."""
    if session.get('delivery_seeded'):
        return
    session['delivery_seeded'] = True
    task = session.get('task', '')
    if not isinstance(task, str) or not re.search(r'报告|资料|写入|保存|生成|整理|report|research|save|write', task, re.I):
        return
    paths = re.findall(r'(?:[\w.-]+/)*[\w.-]+\.(?:md|txt|csv|json|html)\b', task)
    current = session.setdefault('delivery_requirements', [])
    if not isinstance(current, list):
        return
    used_ids = {item.get('id') for item in current
                if isinstance(item, dict) and isinstance(item.get('id'), str)}
    next_id = 1
    for path in dict.fromkeys(paths):
        if len(current) >= MAX_ITEMS:
            break
        if not any(isinstance(item, dict) and item.get('path') == path for item in current):
            while f'output_{next_id}' in used_ids:
                next_id += 1
            ident = f'output_{next_id}'
            used_ids.add(ident)
            next_id += 1
            current.append({'id': ident, 'label': '目标文件：' + path,
                            'path': path, 'contains': [], 'min_links': 0})
GUIDANCE = ('For research, reports, or file deliverables, call delivery_plan before doing the work. '
            'Record every requested person/item as a contains marker, each requested output path, and '
            'required source links (min_links). Do not remove requirements to pass. '
            'The host checks actual file content or the final summary; successful tool execution alone '
            'does not prove the delivery is complete. Missing checks are reported separately.')


def normalize(items):
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        raise ValueError('delivery requirements must contain 1..40 items')
    out, ids = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('invalid delivery requirement')
        ident, label = item.get('id'), item.get('label')
        if not isinstance(ident, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', ident) or ident in ids:
            raise ValueError('invalid or duplicate delivery id')
        if not isinstance(label, str) or not label.strip() or len(label) > 500:
            raise ValueError('invalid delivery label')
        path, markers, links = item.get('path'), item.get('contains', []), item.get('min_links', 0)
        if path is not None and (not isinstance(path, str) or not path.strip() or len(path) > 4096):
            raise ValueError('invalid delivery path')
        if (not isinstance(markers, list) or len(markers) > 100 or
                any(not isinstance(s, str) or not s.strip() or len(s) > 300 for s in markers)):
            raise ValueError('invalid delivery markers')
        if type(links) is not int or not 0 <= links <= 100:
            raise ValueError('invalid minimum source links')
        if path is None and not markers and not links:
            raise ValueError('delivery must specify a file, required content or source links')
        ids.add(ident)
        out.append({'id': ident, 'label': label.strip(), 'path': path,
                    'contains': [s.strip() for s in markers], 'min_links': links})
    return out


def plan(root, gate, args, session, call_id):
    gate.check('todo_write', '')
    if session is None:
        raise ValueError('delivery plan needs a session')
    items = normalize(args.get('items'))
    # Agent may add checks, never weaken an already persisted requirement.
    current = {item['id']: item for item in normalize(session['delivery_requirements'])} if session.get('delivery_requirements') else {}
    for item in items:
        old = current.get(item['id'])
        if old and old != item:
            raise ValueError('existing delivery requirement cannot be rewritten by the model')
        current[item['id']] = item
    if len(current) > MAX_ITEMS:
        raise ValueError('too many delivery requirements')
    session['delivery_requirements'] = list(current.values())
    return {'ok': True, 'items': session['delivery_requirements']}


def check(root, gate, session, summary, *, state_dir=None):
    raw = session.get('delivery_requirements')
    if not raw:
        return {'status': 'not_assessed', 'items': [], 'reason': '未登记交付清单，尚未检查任务内容是否齐全。'}
    try:
        requirements = normalize(raw)
    except ValueError:
        return {'status': 'failed', 'items': [], 'reason': '交付清单无效，请由用户修正。'}
    checked = []
    for item in requirements:
        text, missing = summary or '', []
        if item['path'] is not None:
            try:
                if state_dir is not None:
                    from ...plugin_runtime import require_enabled
                    require_enabled(state_dir, 'files')
                gate.check('read', item['path'])
                raw_bytes = _read_bounded_workspace_file(root, item['path'])
                text = raw_bytes.decode('utf-8')
            except (OSError, ValueError, PermissionError, UnicodeError):
                missing.append('文件不存在、不可读取、插件已禁用或不支持文本检查')
                text = ''
            if not missing and not text.lstrip('\ufeff').strip() and REPORT_RE.search(
                    str(session.get('task', '')) + ' ' + item['label']):
                missing.append('报告文件为空')
        for marker in item['contains']:
            if marker not in text:
                missing.append('缺少内容：' + marker)
        urls = set()
        for candidate in re.findall(r'https?://[^\s<>\[\]）)]+', text):
            try:
                parsed = urlsplit(candidate.rstrip('.,;，。'))
                if parsed.hostname and not parsed.username and not parsed.password:
                    urls.add(candidate)
            except ValueError:
                pass
        if len(urls) < item['min_links']:
            missing.append(f"来源链接不足：{len(urls)}/{item['min_links']}")
        checked.append({**item, 'passed': not missing, 'missing': missing, 'link_count': len(urls)})
    return {'status': 'passed' if all(item['passed'] for item in checked) else 'failed',
            'items': checked, 'scope': '文件存在与文本内容、必需条目和链接数量检查；不证明来源真实性或链接可达。'}


TOOLS = (BuiltinTool('delivery_plan', 'Register an immutable delivery checklist before research/file work; host checks actual files, required names and links',
                    {'items': {'type': 'array', 'items': {'type': 'object', 'properties': {
                        'id': {'type': 'string'}, 'label': {'type': 'string'}, 'path': {'type': 'string'},
                        'contains': {'type': 'array', 'items': {'type': 'string'}}, 'min_links': {'type': 'integer'}},
                        'required': ['id', 'label'], 'additionalProperties': False}}},
                    ('items',), 'todo_write', False, plan),)
