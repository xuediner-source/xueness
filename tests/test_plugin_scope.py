"""Plugin lifecycle scopes: disposal order, service injection, activation set."""
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness import plugin_runtime
from xueness.plugin_scope import (PluginScope, ScopeActive, ScopeRegistry,
                                  ServiceUnavailable, activation_plan)


def row(pid, effective=True, dependencies=(), provides=(), inject=()):
    return {'id': pid, 'effective': effective,
            'dependencies': list(dependencies), 'provides': list(provides),
            'inject': list(inject)}


def entrypoint_with(activate=None):
    return types.SimpleNamespace(activate=activate) if activate is not None else types.SimpleNamespace()


def registry_for(rows, entrypoints, ctx=None):
    ctx = ctx if ctx is not None else {'lock': threading.Lock(), 'state_dir': Path('unused')}
    return ScopeRegistry(ctx, catalog=lambda: rows, entrypoint=lambda pid: entrypoints[pid])


class ScopeTests(unittest.TestCase):
    def test_disposers_run_newest_first_and_a_failure_does_not_stop_the_rest(self):
        scope = PluginScope('demo')
        released = []
        scope.add_disposer(lambda: released.append('first'), label='first')
        scope.add_disposer(lambda: (_ for _ in ()).throw(RuntimeError('stuck')), label='second')
        scope.add_disposer(lambda: released.append('third'), label='third')

        failures = scope.dispose()

        self.assertEqual(released, ['third', 'first'])
        self.assertEqual([item['disposer'] for item in failures], ['second'])
        self.assertEqual(failures[0]['plugin'], 'demo')
        self.assertIn('stuck', failures[0]['error'])
        self.assertEqual(scope.errors, failures)
        self.assertTrue(scope.disposed)
        self.assertEqual(scope.dispose(), [])

    def test_a_disposed_scope_refuses_new_acquisitions(self):
        scope = PluginScope('demo')
        scope.dispose()
        with self.assertRaises(ScopeActive):
            scope.add_disposer(lambda: None)
        with self.assertRaises(ScopeActive):
            scope.ensure('demo.thing', lambda: object())

    def test_inject_names_the_requesting_plugin_and_the_missing_service(self):
        scope = PluginScope('consumer')
        with self.assertRaises(ServiceUnavailable) as caught:
            scope.inject('shared.service')
        self.assertIn('consumer', str(caught.exception))
        self.assertIn('shared.service', str(caught.exception))

    def test_provide_rejects_a_second_owner(self):
        registry = registry_for([], {})
        PluginScope('one', registry).provide('shared.service', 'first')
        with self.assertRaisesRegex(ValueError, 'already provided by plugin "one"'):
            PluginScope('two', registry).provide('shared.service', 'second')

    def test_ensure_acquires_once_and_releases_once(self):
        scope = PluginScope('demo')
        acquired, released = [], []

        def acquire():
            handle = len(acquired)
            acquired.append(handle)
            return handle

        for _ in range(3):
            self.assertEqual(scope.ensure('demo.handle', acquire, released.append), 0)
        self.assertEqual(acquired, [0])
        scope.dispose()
        self.assertEqual(released, [0])

    def test_ensure_retries_when_the_feature_reports_nothing_available(self):
        scope = PluginScope('demo')
        available = [None, 'ready']
        for expected in (None, 'ready'):
            self.assertEqual(scope.ensure('demo.handle', lambda: available.pop(0)), expected)
        self.assertEqual(scope.provided('demo.handle'), 'ready')


class RegistryTests(unittest.TestCase):
    def test_provider_activates_before_the_plugin_that_injects_it(self):
        seen = []

        def provider(scope, ctx):
            scope.provide('shared.counter', 'value')
            seen.append('provider')

        def consumer(scope, ctx):
            seen.append(('consumer', scope.inject('shared.counter')))

        rows = [row('consumer', inject=['shared.counter']), row('provider', provides=['shared.counter'])]
        registry = registry_for(rows, {'consumer': entrypoint_with(consumer), 'provider': entrypoint_with(provider)})

        self.assertEqual(registry.sync()['activated'], ['provider', 'consumer'])
        self.assertEqual(seen, ['provider', ('consumer', 'value')])

    def test_effective_dependencies_set_the_activation_order(self):
        rows = [row('top', dependencies=['mid']), row('mid', dependencies=['base']), row('base')]
        entrypoints = {pid: entrypoint_with(lambda scope, ctx: None) for pid in ('top', 'mid', 'base')}
        registry = registry_for(rows, entrypoints)
        self.assertEqual(registry.sync()['activated'], ['base', 'mid', 'top'])

    def test_injecting_a_service_no_activated_plugin_provides_blocks_the_feature(self):
        calls = []
        publish = lambda scope, ctx: scope.provide('shared.counter', 'value')
        rows = [row('provider', provides=['shared.counter']),
                row('consumer', inject=['shared.counter'])]
        entrypoints = {'provider': entrypoint_with(publish),
                       'consumer': entrypoint_with(lambda scope, ctx: calls.append(scope.inject('shared.counter')))}
        registry = registry_for(rows, entrypoints)

        registry.sync()
        self.assertEqual(calls, ['value'])

        # Turning the provider off withdraws the service, so the consumer cannot activate.
        rows[0]['effective'] = False
        result = registry.sync()
        self.assertEqual(result['activated'], [])
        self.assertEqual(calls, ['value'], 'a blocked feature never re-runs its activation')
        self.assertIn('service unavailable: shared.counter', registry.blocked['consumer'])

        rows[0]['effective'] = True
        self.assertEqual(registry.sync()['activated'], ['provider', 'consumer'])
        self.assertEqual(calls, ['value', 'value'])

    def test_a_provider_that_declares_but_never_publishes_fails_its_injector(self):
        rows = [row('provider', provides=['shared.counter']), row('consumer', inject=['shared.counter'])]
        entrypoints = {'provider': entrypoint_with(lambda scope, ctx: None),
                       'consumer': entrypoint_with(lambda scope, ctx: scope.inject('shared.counter'))}
        registry = registry_for(rows, entrypoints)

        blocked = registry.sync()['blocked']
        self.assertIn('activation failed', blocked['consumer'])
        self.assertIn('shared.counter', blocked['consumer'])
        self.assertEqual(registry.activated, ('provider',))
        self.assertIsNone(registry.scope('consumer'))

    def test_a_blocked_provider_blocks_the_feature_that_injects_it(self):
        rows = [row('provider', provides=['shared.counter'], dependencies=['base']),
                row('consumer', inject=['shared.counter']), row('base', effective=False)]
        entrypoints = {pid: entrypoint_with(lambda scope, ctx: scope.provide('shared.counter', 'value'))
                       for pid in ('provider', 'consumer')}
        registry = registry_for(rows, entrypoints)

        blocked = registry.sync()['blocked']
        self.assertIn('dependency not effective: base', blocked['provider'])
        self.assertIn('provider cannot activate: shared.counter', blocked['consumer'])
        self.assertEqual(registry.activated, ())

    def test_cyclic_injection_reports_a_reason_instead_of_activating(self):
        rows = [row('one', provides=['svc.one'], inject=['svc.two']),
                row('two', provides=['svc.two'], inject=['svc.one'])]
        entrypoints = {pid: entrypoint_with(lambda scope, ctx: None) for pid in ('one', 'two')}
        registry = registry_for(rows, entrypoints)
        self.assertEqual(registry.sync()['activated'], [])
        self.assertIn('cyclic service injection', registry.blocked['one'])

    def test_disabling_disposes_and_re_enabling_activates_again(self):
        acquired, released = [], []

        def activate(scope, ctx):
            def acquire():
                handle = len(acquired)
                acquired.append(handle)
                return handle

            scope.ensure('demo.handle', acquire, released.append)

        rows = [row('demo')]
        registry = registry_for(rows, {'demo': entrypoint_with(activate)})

        registry.sync()
        registry.sync()
        self.assertEqual(len(acquired), 1, 'a live acquisition is not repeated every sync')

        rows[0]['effective'] = False
        registry.sync()
        self.assertEqual(released, [0])
        self.assertEqual(registry.activated, ())
        self.assertIsNone(registry.service('demo.handle'))

        rows[0]['effective'] = True
        registry.sync()
        self.assertEqual(len(acquired), 2, 're-enabling builds a fresh scope')
        self.assertEqual(registry.activated, ('demo',))
        registry.dispose()
        self.assertEqual(released, [0, 1])

    def test_a_service_the_host_replaced_is_acquired_again(self):
        released = []

        def activate(scope, ctx):
            def acquire():
                handle = ctx.get('demo_service')
                if handle is None:
                    handle = object()
                    ctx['demo_service'] = handle
                return handle

            scope.ensure('demo.handle', acquire, released.append,
                         live=lambda handle: ctx.get('demo_service') is handle)

        ctx = {'lock': threading.Lock()}
        registry = ScopeRegistry(ctx, catalog=lambda: [row('demo')],
                                 entrypoint=lambda pid: entrypoint_with(activate))
        registry.sync()
        first = ctx['demo_service']
        # Another feature may have to stop the service, as an update does.
        ctx['demo_service'] = None
        registry.sync()
        self.assertIsNot(ctx['demo_service'], first)
        self.assertEqual(released, [], 'a handle the host already dropped is not released twice')
        registry.dispose()
        self.assertEqual(len(released), 2)

    def test_a_failing_activation_is_reported_and_retried(self):
        attempts = []

        def activate(scope, ctx):
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError('worker missing')

        registry = registry_for([row('demo')], {'demo': entrypoint_with(activate)})
        self.assertIn('activation failed: worker missing', registry.sync()['blocked']['demo'])
        self.assertEqual(registry.activated, ())
        registry.sync()
        self.assertEqual(len(attempts), 2)
        self.assertEqual(registry.activated, ('demo',))

    def test_features_without_an_activate_hook_contribute_no_scope(self):
        rows = [row('plain'), row('declares', provides=['plain.thing']), row('worker')]
        entrypoints = {pid: entrypoint_with() for pid in ('plain', 'declares')}
        entrypoints['worker'] = entrypoint_with(lambda scope, ctx: scope.provide('worker.handle', object()))
        registry = registry_for(rows, entrypoints)

        self.assertEqual(registry.sync()['activated'], ['worker'])
        self.assertIsNone(registry.scope('declares'), 'a manifest entry alone acquires nothing')
        self.assertIsNone(registry.service_owner('plain.thing'))
        self.assertEqual(registry.service_owner('worker.handle'), 'worker')


class RuntimeWiringTests(unittest.TestCase):
    """Bundled features, not the host, must own the service keys in ctx."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'state'
        self.state.mkdir()
        self.ctx = {'state_dir': self.state, 'lock': threading.Lock()}

    def tearDown(self):
        registry = self.ctx.get('plugin_scopes')
        if registry is not None:
            registry.dispose()

    def test_terminal_and_automation_lifecycle_comes_from_their_own_plugins(self):
        plugin_runtime.sync_services(self.ctx)
        registry = self.ctx['plugin_scopes']
        self.assertIsNotNone(self.ctx['terminals'])
        self.assertEqual(registry.service_owner('terminal.broker'), 'terminal')
        self.assertIn('terminal', registry.activated)
        self.assertIsNone(self.ctx.get('automation_service'), 'no scheduler before the host serves plugins')

        self.ctx['serve_plugins'] = True
        plugin_runtime.sync_services(self.ctx)
        scheduler = self.ctx['automation_service']
        self.assertIsNotNone(scheduler)
        self.assertEqual(registry.service_owner('automation.scheduler'), 'automation')

        plugin_runtime.set_enabled(self.state, 'terminal', False)
        plugin_runtime.sync_services(self.ctx)
        self.assertIsNone(self.ctx['terminals'])
        self.assertNotIn('terminal', registry.activated)

        plugin_runtime.set_enabled(self.state, 'terminal', True)
        plugin_runtime.sync_services(self.ctx)
        self.assertIsNotNone(self.ctx['terminals'])

        plugin_runtime.set_enabled(self.state, 'automation', False)
        plugin_runtime.sync_services(self.ctx)
        self.assertIsNone(self.ctx['automation_service'])
        self.assertFalse(scheduler.thread.is_alive())

    def test_closed_admission_does_not_start_a_scheduler_and_reopening_does(self):
        self.ctx['serve_plugins'] = True
        self.ctx['admission_closed'] = True
        plugin_runtime.sync_services(self.ctx)
        self.assertIsNone(self.ctx.get('automation_service'))
        self.ctx['admission_closed'] = False
        plugin_runtime.sync_services(self.ctx)
        self.assertIsNotNone(self.ctx['automation_service'])

    def test_disabling_the_browser_releases_its_worker_handle(self):
        plugin_runtime.set_enabled(self.state, 'browser', True)
        with patch('xueness.bundled_plugins.browser.plugin.shutdown') as stopped:
            plugin_runtime.sync_services(self.ctx)
            self.assertIn('browser', self.ctx['plugin_scopes'].activated)
            stopped.assert_not_called()
            plugin_runtime.set_enabled(self.state, 'browser', False)
            plugin_runtime.sync_services(self.ctx)
            stopped.assert_called_once_with(self.state.resolve())

    def test_catalog_separates_effective_from_activated(self):
        rows = {item['id']: item for item in plugin_runtime.catalog(self.state)}
        self.assertTrue(rows['terminal']['effective'])
        self.assertTrue(rows['terminal']['activated'])
        self.assertNotIn('activationError', rows['terminal'])
        self.assertFalse(rows['browser']['effective'])
        self.assertFalse(rows['browser']['activated'])

        plugin_runtime.set_enabled(self.state, 'sessions', False)
        rows = {item['id']: item for item in plugin_runtime.catalog(self.state)}
        self.assertFalse(rows['sessions']['activated'])
        self.assertFalse(rows['terminal']['activated'], 'a dependency cascade keeps activation honest')

    def test_activation_plan_only_reports_enabled_features(self):
        self.assertEqual(activation_plan([row('gone', effective=False, inject=['nope'])]), ([], {}))


if __name__ == '__main__':
    unittest.main()
