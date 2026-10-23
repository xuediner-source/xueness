"""Python oracle for the @xueness/sessions differential tests.

Reads one JSON request on stdin and prints one JSON reply. Values cross the
pipe as JSON, which both sides decode losslessly.
"""
import json
import os
import sys
import time
from pathlib import Path

from xueness import core
from xueness.bundled_plugins.sessions import history, work_activity


def error_name(exc):
    return type(exc).__name__


def scan(path):
    try:
        state, records, size = history._scan(Path(path))
        return {'ok': True, 'stateHash': history.digest(state), 'records': len(records), 'size': size,
                'seqs': [row['seq'] for row in records]}
    except Exception as exc:  # noqa: BLE001 - the class name is the oracle
        return {'ok': False, 'error': error_name(exc)}


def main():
    request = json.loads(sys.stdin.read())
    op = request['op']
    if op == 'difference':
        print(json.dumps([history.difference(a, b) for a, b in request['pairs']]))
    elif op == 'scan':
        print(json.dumps([scan(path) for path in request['paths']]))
    elif op == 'identity':
        out = []
        for session in request['sessions']:
            try:
                core._ensure_message_identity(session)
                out.append({'ok': session})
            except Exception as exc:  # noqa: BLE001
                out.append({'error': error_name(exc)})
        print(json.dumps(out))
    elif op == 'transcript':
        out = []
        for case in request['cases']:
            session = case['session']
            try:
                changed = history.preserve_interrupted_partial(session, case['turn_id'],
                                                               previous_stream_id=case.get('previous'))
                history.settle_reasoning_timing(session)
                out.append({'changed': changed, 'session': session})
            except Exception as exc:  # noqa: BLE001
                out.append({'error': error_name(exc)})
        print(json.dumps(out))
    elif op == 'work':
        out = []
        for case in request['cases']:
            session = case['session']
            trace = []
            try:
                for step in case['steps']:
                    kind = step[0]
                    if kind == 'start':
                        work_activity.start(session, reason=step[1], turn_id=step[2])
                    elif kind == 'status':
                        session['status'] = step[1]
                    elif kind == 'checkpoint':
                        work_activity.checkpoint(session)
                    elif kind == 'settle':
                        work_activity.settle(session, returned=step[1])
                    elif kind == 'replay':
                        work_activity.replay_finished(session, step[1])
                    elif kind == 'public':
                        trace.append(work_activity.public_segments(session))
                out.append({'session': session, 'trace': trace})
            except Exception as exc:  # noqa: BLE001
                out.append({'error': error_name(exc)})
        print(json.dumps(out))
    elif op == 'save':
        # Save each session in order with the real Store (hooks included).
        store = core.Store(Path(request['directory']))
        out = []
        for session in request['sessions']:
            try:
                store.save(session)
                out.append({'ok': True, 'session': session})
            except Exception as exc:  # noqa: BLE001
                out.append({'ok': False, 'error': error_name(exc),
                            'stage': getattr(exc, '_xueness_store_stage', None)})
        print(json.dumps(out))
    elif op == 'load':
        store = core.Store(Path(request['directory']))
        out = []
        for sid in request['ids']:
            try:
                out.append({'ok': store.load(sid)})
            except Exception as exc:  # noqa: BLE001
                out.append({'error': error_name(exc)})
        print(json.dumps(out))
    elif op == 'new':
        store = core.Store(Path(request['directory']))
        try:
            print(json.dumps({'ok': store.new(request['task'], Path(request['root']),
                                              session_id=request.get('session_id'))}))
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({'error': error_name(exc)}))
    elif op == 'list':
        print(json.dumps(core.Store(Path(request['directory'])).list()))
    elif op == 'page':
        store = core.Store(Path(request['directory']))
        out = []
        for sid, cursor, limit in request['queries']:
            try:
                out.append({'ok': history.page(store, sid, cursor, limit)})
            except Exception as exc:  # noqa: BLE001
                out.append({'error': error_name(exc)})
        print(json.dumps(out))
    elif op == 'hold':
        # Hold a named lock for a while, to test cross-process exclusion.
        from xueness.session_lease import exclusive_lock
        with exclusive_lock(Path(request['directory']), request['name']):
            print(json.dumps({'held': True}), flush=True)
            time.sleep(request['seconds'])
        print(json.dumps({'released': True}), flush=True)
    elif op == 'try_lock':
        from xueness.session_lease import exclusive_lock
        started = time.monotonic()
        try:
            with exclusive_lock(Path(request['directory']), request['name'], timeout=request['timeout']):
                print(json.dumps({'ok': True, 'waited': time.monotonic() - started}))
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({'ok': False, 'error': error_name(exc)}))
    elif op == 'system':
        print(json.dumps(core.SYSTEM))
    else:
        raise SystemExit(f'unknown op {op}')


if __name__ == '__main__':
    main()
