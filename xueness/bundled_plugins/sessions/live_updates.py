"""Snapshot-first SSE with revisioned projection patches and bounded connection lifetime."""
from __future__ import annotations
import json
import time
from pathlib import Path

from ... import plugin_runtime
from ...http_contract import HANDLED_RESPONSE
from . import history


def _send(handler, event, revision, value):
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    handler.wfile.write(f'id: {revision}\nevent: {event}\ndata: {data}\n\n'.encode('utf-8'))
    handler.wfile.flush()


def _signature(ctx, sid):
    directory = Path(ctx['store'].directory)
    paths = [directory / (sid + '.json'), directory / 'session-message-queues' / (sid + '.json'),
             directory / 'session-turn-inputs' / (sid + '.json')]
    out = []
    for path in paths:
        try:
            info = path.stat()
            out.append((info.st_size, info.st_mtime_ns, info.st_ino))
        except FileNotFoundError:
            out.append(None)
    return tuple(out)


def dispatch(method, parts, query, data, ctx):
    if method != 'GET' or len(parts) != 4 or parts[:2] != ['api', 'sessions'] or parts[3] != 'updates':
        return None
    handler = ctx.get('handler')
    streaming = handler is not None and 'text/event-stream' in handler.headers.get('Accept', '')
    from .conversation_snapshot import snapshot
    try:
        # Keep legacy JSON consumers complete. SSE clients only need the live
        # tail; older transcript pages are fetched separately by the workbench.
        previous = snapshot(ctx, parts[2], window={'tail': True, 'before': 0, 'limit': 80}) if streaming \
            else snapshot(ctx, parts[2])
    except FileNotFoundError:
        return 404, {'error': 'session not found'}
    except (OSError, ValueError):
        return 409, {'error': 'conversation unavailable'}
    if not streaming:
        return 200, previous
    revision = previous['journal'].get('history_revision', 0)
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/event-stream; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Connection', 'close')
    handler.end_headers()
    deadline, heartbeat = time.monotonic() + 25, time.monotonic()
    signature, refresh_at = _signature(ctx, parts[2]), time.monotonic() + 2
    try:
        _send(handler, 'conversation.snapshot', revision, {'revision': revision, 'snapshot': previous})
        while time.monotonic() < deadline and plugin_runtime.is_enabled(ctx['state_dir'], 'sessions'):
            history.wait(.2)
            current_signature = _signature(ctx, parts[2])
            if current_signature == signature and time.monotonic() < refresh_at:
                continue
            signature, refresh_at = current_signature, time.monotonic() + 2
            current = snapshot(ctx, parts[2], window={'tail': True, 'before': 0, 'limit': 80})
            next_revision = current['journal'].get('history_revision', 0)
            operations = history.difference(previous, current)
            if operations:
                _send(handler, 'conversation.patch', next_revision,
                      dict(baseRevision=revision, revision=next_revision, operations=operations))
                previous, revision = current, next_revision
            if time.monotonic() - heartbeat > 8:
                handler.wfile.write(b': heartbeat\n\n')
                handler.wfile.flush()
                heartbeat = time.monotonic()
    except (OSError, ValueError, KeyError):
        pass  # reconnect always begins with an authoritative snapshot
    finally:
        handler.close_connection = True
    return HANDLED_RESPONSE
