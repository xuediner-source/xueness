"""Web controls for durable workflows, MCP diagnostics and delegated tasks."""
from pathlib import Path
from ...workflows import WorkflowStore
from ...diagnostics import check_mcp


def dispatch(method, parts, query, data, ctx):
    workflow = len(parts) >= 2 and parts[:2] == ['api', 'workflows']
    diagnostic = parts == ['api', 'mcp', 'check']
    tasks = len(parts) == 4 and parts[:2] == ['api', 'sessions'] and parts[3] == 'tasks'
    if not (workflow or diagnostic or tasks):
        return None
    from ...web import _allowed_root
    def root_for(value):
        if not isinstance(value, str) or not value:
            raise ValueError('workspace root is required')
        from ..settings.workspaces_api import allowed_roots
        return _allowed_root(Path(value), ctx['web_runs'], ctx['project_dir'], allowed_roots(ctx))
    try:
        if workflow and len(parts) >= 3 and parts[2] == 'expert':
            from . import expert
            return expert.dispatch_http(method, parts, query, data, ctx)
        if tasks and method == 'GET':
            session = ctx['store'].load(parts[2])
            raw_runs = session.get('task_runs')
            runs_list = raw_runs if isinstance(raw_runs, list) else []
            live = ctx['task_registry'].list(parts[2])
            live_list = live if isinstance(live, list) else []
            tasks_by_id = {t['id']: t for t in runs_list if isinstance(t, dict) and 'id' in t}
            tasks_by_id.update({t['id']: t for t in live_list if isinstance(t, dict) and 'id' in t})
            merged = list(tasks_by_id.values())
            merged.sort(key=lambda t: (t.get('startedAt') or 0, t.get('id') or ''))
            return 200, {'tasks': merged}
        if diagnostic and method == 'POST':
            if data.get('connect') is not True:
                return 400, {'error': 'explicit connect approval required'}
            return 200, check_mcp(ctx['state_dir'], data.get('id'), root_for(data.get('root')))
        if not workflow:
            return 405, {'error': 'method not allowed'}
        if len(parts) >= 3 and parts[2] == 'dwf':
            from . import dynamic_runs
            return dynamic_runs.dispatch(method, parts, query, data, ctx)
        store = WorkflowStore(ctx['state_dir'])
        def submitted_plan(payload, root):
            has_plan, has_script = 'plan' in payload, 'script' in payload
            if has_plan == has_script:
                raise ValueError('provide exactly one of plan or script')
            if has_plan:
                return payload['plan']
            from .dsl import compile_workflow_script
            return compile_workflow_script(payload['script'], root)
        if len(parts) == 2:
            if method == 'GET':
                visible = []
                for item in store.list():
                    try:
                        root_for(item['root'])
                        visible.append(item)
                    except ValueError:
                        pass
                return 200, {'workflows': visible}
            if method == 'POST':
                root = root_for(data.get('root'))
                return 200, store.create(submitted_plan(data, root), root, data.get('reuse'))
        if len(parts) >= 3:
            wid = parts[2]
            record = store.load(wid)
            # CLI-created runs outside the server's approved roots are not exposed.
            root_for(record['root'])
            if len(parts) == 3 and method == 'GET':
                return 200, record
            if len(parts) == 5 and parts[3] == 'logs' and method == 'GET':
                return 200, store.log(wid, parts[4])
            if len(parts) == 6 and parts[3] == 'actors' and parts[5] == 'answer' and method == 'POST':
                node_id = parts[4]
                return 200, store.answer_actor(wid, node_id, data.get('answer'))
            if len(parts) == 4 and method == 'POST':
                if parts[3] == 'amend':
                    return 200, store.amend(wid, submitted_plan(data, root_for(record['root'])),
                                             root_for(record['root']))
                if parts[3] in ('start', 'resume'):
                    return 200, store.launch(wid, approved=data.get('approve') is True, allow_real=ctx['allow_real'])
                return 200, store.control(wid, parts[3], data.get('concurrency'))
        return 404, {'error': 'operation not found'}
    except BlockingIOError:
        return 409, {'error': 'run has a live owner'}
    except FileNotFoundError:
        return 404, {'error': 'resource not found'}
    except (ValueError, TypeError, KeyError):
        return 400, {'error': 'invalid operation, plan, approval or workspace'}
