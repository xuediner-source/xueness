"""Compatibility launcher for xueness.bundled_plugins.workflows.workflow_worker."""
if __name__ == '__main__':
    import runpy
    runpy.run_module('xueness.bundled_plugins.workflows.workflow_worker', run_name='__main__')
else:
    import importlib
    import sys
    sys.modules[__name__] = importlib.import_module('xueness.bundled_plugins.workflows.workflow_worker')
