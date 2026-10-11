"""Transparent adapter decoration preserving cloning and protocol semantics."""
from copy import copy


class ProviderProxy:
    _proxy_fields = frozenset({'state_dir', 'provider_id', 'provider'})

    @property
    def __class__(self):
        # Existing embedders use isinstance to clone protocol-specific options.
        return self.provider.__class__

    def __getattr__(self, name):
        if name == 'protocol':
            from .provider import AnthropicMessages
            return getattr(self.provider, name, 'anthropic' if isinstance(self.provider, AnthropicMessages) else 'openai')
        return getattr(self.provider, name)

    def __setattr__(self, name, value):
        if name in self._proxy_fields:
            object.__setattr__(self, name, value)
        else:
            setattr(self.provider, name, value)

    def __copy__(self):
        clone = object.__new__(type(self))
        for name, value in vars(self).items():
            object.__setattr__(clone, name, copy(value) if name == 'provider' else value)
        return clone
