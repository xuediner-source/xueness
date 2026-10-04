"""Plugin lifecycle scopes, modelled on the Cordis "everything is a plugin" idea.

Why this exists: the registry used to know which service a terminal, browser or
automation feature owned, so every new lifecycle added shared-kernel code. A
scope moves that ownership into the plugin: the feature acquires resources and
registers its own disposers, and the registry only decides *when* to activate or
dispose it as the effective set changes.

Manifests stay data. ``provides``/``inject``/``httpFamilies`` are string arrays
read from the trusted build packages; activation still comes from that allowlist
plus the boolean switches in ``plugin-state.json``, never from state files.
"""
from __future__ import annotations

import threading


class ServiceUnavailable(RuntimeError):
    """A plugin asked for a service no activated plugin provides."""


class ScopeActive(ValueError):
    """The scope is already disposed, so it may not acquire anything new."""


def _text_list(value) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, str) and item)


class PluginScope:
    """The resources and services one active plugin owns.

    ``activate`` is a reconcile hook that runs whenever the feature is
    effective, so :meth:`ensure` is the usual way to acquire: it creates at most
    once per scope and releases exactly once on :meth:`dispose`.
    """

    def __init__(self, plugin_id, registry=None):
        self.plugin_id = plugin_id
        self.errors = []
        self._registry = registry
        self._disposers = []
        self._services = {}
        self._disposed = False

    @property
    def disposed(self):
        return self._disposed

    def add_disposer(self, dispose, label=''):
        """Register teardown for something acquired while the feature is active."""
        if self._disposed:
            raise ScopeActive('plugin scope already disposed: ' + self.plugin_id)
        if not callable(dispose):
            raise TypeError('disposer must be callable')
        self._disposers.append((label or getattr(dispose, '__qualname__', None) or repr(dispose), dispose))

    def provide(self, name, service):
        """Publish a service that other plugins may declare in ``inject``."""
        if not isinstance(name, str) or not name:
            raise ValueError('service name required')
        owner = self._registry.service_owner(name) if self._registry is not None else None
        if owner is not None and owner != self.plugin_id:
            raise ValueError('service "%s" is already provided by plugin "%s"' % (name, owner))
        self._services[name] = service
        if self._registry is not None:
            self._registry._publish(self.plugin_id, name, service)
        return service

    def provided(self, name):
        """The service this scope publishes under ``name``, or None."""
        return self._services.get(name)

    def inject(self, name):
        """Read a service another activated plugin provided."""
        if self._registry is not None:
            entry = self._registry.lookup(name)
        elif name in self._services:
            entry = (self.plugin_id, self._services[name])
        else:
            entry = None
        if entry is None:
            raise ServiceUnavailable(
                'service "%s" required by plugin "%s" is not provided by an activated plugin'
                % (name, self.plugin_id))
        return entry[1]

    def ensure(self, name, acquire, release=None, live=None):
        """Return the live service for ``name``, acquiring it at most once.

        ``acquire`` returning None means "not available yet" and retries on the
        next sync. When ``live`` rejects the previously acquired value, the new
        one is published and released the same way.
        """
        if self._disposed:
            raise ScopeActive('plugin scope already disposed: ' + self.plugin_id)
        if name in self._services and (live is None or live(self._services[name])):
            return self._services[name]
        service = acquire()
        if service is None:
            return None
        self.provide(name, service)
        if release is not None:
            self.add_disposer(lambda: release(service), label='release ' + name)
        return service

    @property
    def services(self):
        return dict(self._services)

    def dispose(self):
        """Release everything this scope acquired, newest first.

        One failing disposer must not strand the others, so its error is
        recorded and the remaining teardown continues.
        """
        if self._disposed:
            return []
        self._disposed = True
        for name in list(self._services):
            if self._registry is not None:
                self._registry._withdraw(self.plugin_id, name)
        disposers, self._disposers = self._disposers, []
        failures = []
        for label, dispose in reversed(disposers):
            try:
                dispose()
            except Exception as exc:
                failures.append({'plugin': self.plugin_id, 'disposer': label, 'error': str(exc)})
        self.errors.extend(failures)
        self._services.clear()
        return failures


class ScopeRegistry:
    """Activate and dispose scopes as the catalog's effective set changes."""

    def __init__(self, ctx, catalog=None, entrypoint=None):
        self._ctx = ctx
        self._catalog = catalog
        self._entrypoint = entrypoint
        self._lock = threading.RLock()
        self._services = {}
        self._scopes = {}
        self._order = []
        self.blocked = {}
        self.errors = []

    @property
    def ctx(self):
        return self._ctx

    @property
    def activated(self):
        return tuple(self._scopes)

    def scope(self, plugin_id):
        return self._scopes.get(plugin_id)

    def lookup(self, name):
        return self._services.get(name)

    def service_owner(self, name):
        entry = self._services.get(name)
        return entry[0] if entry else None

    def service(self, name):
        entry = self._services.get(name)
        return entry[1] if entry else None

    def _publish(self, plugin_id, name, service):
        self._services[name] = (plugin_id, service)

    def _withdraw(self, plugin_id, name):
        entry = self._services.get(name)
        if entry is not None and entry[0] == plugin_id:
            self._services.pop(name, None)

    def _rows(self, items):
        if items is not None:
            return list(items)
        if self._catalog is not None:
            return list(self._catalog())
        from . import plugin_runtime
        return plugin_runtime.catalog(self._ctx['state_dir'])

    def _load(self, plugin_id):
        if self._entrypoint is not None:
            return self._entrypoint(plugin_id)
        from . import plugin_runtime
        return plugin_runtime.entrypoint(plugin_id)

    def _activation_hook(self, plugin_id):
        """The plugin's reconcile hook, or None when it takes no part in the lifecycle."""
        try:
            entrypoint = self._load(plugin_id)
        except Exception:
            # A package that cannot load is reported by the catalog paths that own
            # it; the lifecycle has nothing to activate for it either.
            return None
        activate = getattr(entrypoint, 'activate', None)
        return activate if callable(activate) else None

    def _apply_lock(self):
        # HTTP handlers serialize lifecycle changes on the host lock when they
        # have one; CLI and test callers may pass a plain context dict.
        lock = self._ctx.get('lock')
        return lock if lock is not None else self._lock

    def sync(self, items=None):
        """Reconcile every effective plugin that takes part in the lifecycle."""
        rows = self._rows(items)
        order, blocked = activation_plan(rows)
        with self._apply_lock():
            for plugin_id in [pid for pid in reversed(self._order) if pid not in order]:
                self._retire(plugin_id)
            for plugin_id in order:
                activate = self._activation_hook(plugin_id)
                if activate is None:
                    continue
                scope = self._scopes.get(plugin_id)
                if scope is None:
                    scope = self._scopes[plugin_id] = PluginScope(plugin_id, self)
                try:
                    activate(scope, self._ctx)
                except Exception as exc:
                    failures = scope.dispose()
                    self._scopes.pop(plugin_id, None)
                    self.errors.extend(failures)
                    blocked[plugin_id] = 'activation failed: ' + str(exc)
            self._order = [pid for pid in order if pid in self._scopes]
            self.blocked = blocked
        return {'activated': self._order, 'blocked': dict(blocked)}

    def _retire(self, plugin_id):
        scope = self._scopes.pop(plugin_id, None)
        self._order = [pid for pid in self._order if pid != plugin_id]
        if scope is None:
            return []
        failures = scope.dispose()
        self.errors.extend(failures)
        return failures

    def deactivate(self, plugin_id):
        """Dispose one scope while its plugin stays effective.

        The next sync re-acquires whatever the feature still needs, so a host
        that had to stop a service (an update draining its timers) does not
        leave it off until the operator toggles the plugin.
        """
        with self._apply_lock():
            return self._retire(plugin_id)

    def dispose(self, plugin_id=None):
        """Dispose one scope, or every scope when no plugin is named."""
        if plugin_id is not None:
            return self.deactivate(plugin_id)
        with self._apply_lock():
            for pid in reversed(self._order):
                self._retire(pid)
            self._order = []
            return list(self.errors)


def activation_plan(rows):
    """Order effective plugins so providers activate before their dependents.

    Returns ``(order, blocked)``. ``blocked`` explains per plugin why an enabled
    feature cannot activate: no enabled plugin provides an injected service, the
    provider itself cannot activate, dependencies are unavailable, or two
    features inject each other's services.
    """
    by_id = {row['id']: row for row in rows if isinstance(row.get('id'), str)}
    candidates = [pid for pid, row in by_id.items() if row.get('effective')]
    candidate_set = set(candidates)
    providers = {}
    for pid in candidates:
        for name in _text_list(by_id[pid].get('provides')):
            providers.setdefault(name, pid)
    order: list[str] = []
    ready: set[str] = set()
    blocked: dict[str, str] = {}
    pending = list(candidates)

    def wanted(pid):
        """Injected services this feature needs, minus the ones it publishes."""
        published = _text_list(by_id[pid].get('provides'))
        return [name for name in _text_list(by_id[pid].get('inject')) if name not in published]

    def failure(pid):
        parts = []
        dead_deps = [dep for dep in _text_list(by_id[pid].get('dependencies'))
                     if dep in by_id and dep not in candidate_set]
        if dead_deps:
            parts.append('dependency not effective: ' + ', '.join(dead_deps))
        for name in dict.fromkeys(name for name in wanted(pid)
                                  if providers.get(name) is None or providers[name] in blocked):
            parts.append('service unavailable: ' + name
                         if providers.get(name) is None else 'provider cannot activate: ' + name)
        return '; '.join(parts) or None

    while pending:
        progressed = False
        for pid in list(pending):
            detail = failure(pid)
            if detail:
                pending.remove(pid)
                blocked[pid] = detail
                progressed = True
                continue
            waiting = [providers[name] for name in wanted(pid)
                       if providers.get(name) is not None and providers[name] not in ready]
            waiting += [dep for dep in _text_list(by_id[pid].get('dependencies'))
                        if dep in candidate_set and dep not in ready]
            if waiting:
                continue
            pending.remove(pid)
            ready.add(pid)
            order.append(pid)
            progressed = True
        if not progressed:
            for pid in pending:
                cycle = [name for name in wanted(pid) if providers.get(name) in pending]
                blocked[pid] = 'cyclic service injection' + (': ' + ', '.join(cycle) if cycle else '')
            pending.clear()
    return order, blocked
