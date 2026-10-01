"""Kernel contract for trusted bundled capability plugins."""
from __future__ import annotations


class Plugin:
    """One opt-in capability implementation.

    ``load`` returns keyword arguments for ``core.run``. ``teardown`` releases
    resources acquired while loading and must be safe to call more than once.
    """

    kind = ""

    def load(self, state_dir, root, session) -> dict:  # pragma: no cover - interface
        raise NotImplementedError

    def teardown(self) -> None:
        """Release acquired resources. Safe to call repeatedly."""
