"""Trusted entrypoint for the terminal plugin."""
def dispatch(method, parts, query, data, ctx):
    from . import terminals
    return terminals.dispatch(method, parts, query, data, ctx)


def create_service():
    from .terminals import Broker
    return Broker()


def activate(scope, ctx):
    """Hold the workspace PTY broker, including one the host already opened."""
    def acquire():
        broker = ctx.get('terminals')
        if broker is None:
            broker = create_service()
        ctx['terminals'] = broker
        return broker

    def release(broker):
        broker.close()
        if ctx.get('terminals') is broker:
            ctx['terminals'] = None

    scope.ensure('terminal.broker', acquire, release,
                 live=lambda broker: ctx.get('terminals') is broker)
