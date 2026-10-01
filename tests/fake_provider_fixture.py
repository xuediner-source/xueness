"""Test-only injection seam for no-cost CLI and HTTP run tests."""
from contextlib import contextmanager
from unittest.mock import patch

from xueness.provider import FakeProvider


@contextmanager
def inject_provider(provider=None, ctx=None):
    """Replace model resolution with an internal fixture, never live API calls."""
    previous = None
    if ctx is not None:
        previous = ctx.get("allow_real")
        ctx["allow_real"] = True
    try:
        with patch("xueness.provider_config.resolve",
                   return_value=provider if provider is not None else FakeProvider()):
            yield
    finally:
        if ctx is not None:
            ctx["allow_real"] = previous


def patch_provider_resolution(test, provider=None):
    """Patch resolution for a TestCase whose CLI path reaches a model call."""
    active = patch("xueness.provider_config.resolve",
                   return_value=provider if provider is not None else FakeProvider())
    active.start()
    test.addCleanup(active.stop)
    return active
