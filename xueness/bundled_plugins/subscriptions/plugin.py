"""Trusted subscription feature and inert marketplace activation marker."""
from ...plugin_contract import Plugin


class SubscriptionsPlugin(Plugin):
    def load(self, state_dir, root, session):
        # A marketplace resource never becomes an executable model adapter.
        # Provider resolution is owned by this bundled feature instead.
        return {}


def dispatch(method, parts, query, data, ctx):
    from .accounts import dispatch as handle
    return handle(method, parts, query, data, ctx)


def on_disabled(state_dir):
    from .broker import shutdown
    shutdown(state_dir)


def activate(scope, ctx):
    state_dir = ctx['state_dir']
    scope.ensure('subscriptions.worker', lambda: state_dir, on_disabled)
