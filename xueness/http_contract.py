"""Shared HTTP adapter response marker, independent of server entrypoint."""

# `python -m xueness.web` loads the server as __main__. Feature adapters may
# subsequently import xueness.web by its canonical name. Keeping the marker in
# this module preserves its identity in both server instances.
HANDLED_RESPONSE = object()
