"""Frozen backend entrypoint; worker routes remain owned by their plugins."""
import os
import runpy
import sys


def _plugin_cli_request(argv):
    """Recognize trusted worker commands without scanning option values."""
    index = 0
    while index < len(argv):
        option = argv[index]
        if option in ('--state', '--language'):
            if index + 1 >= len(argv):
                return False
            index += 2
        elif option.startswith(('--state=', '--language=')):
            index += 1
        else:
            return option in ('pi-lite-worker', 'mcp-acp-worker', 'extension-package')
    return False


def main():
    if not getattr(sys, "frozen", False):
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    if len(sys.argv) > 2 and sys.argv[1] == '--worker':
        if os.environ.get('XUENESS_DESKTOP_SMOKE_TRACE') == '1':
            import faulthandler
            faulthandler.dump_traceback_later(3, repeat=True)
        module = {'workflow': 'xueness.bundled_plugins.workflows.workflow_worker',
                  'terminal': 'xueness.bundled_plugins.terminal.terminal_worker',
                  'terminal-interrupt': 'xueness.bundled_plugins.terminal.windows_interrupt',
                  'terminal-shell': 'xueness.bundled_plugins.terminal.windows_shell'}.get(sys.argv[2])
        if module is None:
            raise SystemExit('unknown worker')
        sys.argv = [module, *sys.argv[3:]]
        runpy.run_module(module, run_name='__main__')
        return 0
    if sys.argv[1:2] == ['--cli'] or _plugin_cli_request(sys.argv[1:]):
        # The existing CLI registry owns dispatch and effective plugin checks;
        # freezing must not redirect these launches into desktop HTTP startup.
        from xueness.cli import main as cli
        return cli(sys.argv[2:] if sys.argv[1:2] == ['--cli'] else sys.argv[1:])
    os.environ['XUENESS_DESKTOP_HOST'] = '1'
    if os.name == 'nt':
        from xueness.bundled_plugins.desktop.windows_job import protect_process_tree
        protect_process_tree()
    from xueness.bundled_plugins.desktop.host import main as serve
    return serve()


if __name__ == '__main__':
    raise SystemExit(main())
