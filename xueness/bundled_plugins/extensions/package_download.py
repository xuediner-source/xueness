"""Bounded ZIP downloads over the existing public-address-pinned HTTPS seam."""
from __future__ import annotations

import time

from ... import plugin_runtime
from ..network.transport import _parse_https_url, resolve_public, _PinnedHTTPS
from ..network.search_settings import get_settings

MAX_ARCHIVE_BYTES = 16 * 1024 * 1024


def download(state, url):
    for pid in ('extensions', 'network'):
        plugin_runtime.require_enabled(state, pid)
    parsed, host = _parse_https_url(url, allow_query=False)
    addresses, _ = resolve_public(host, get_settings(state).get('dohEndpoint') or '')
    connection = _PinnedHTTPS(host, addresses[0], timeout=15)
    deadline = time.monotonic() + 30
    try:
        connection.request('GET', parsed.path or '/', headers={
            'Accept': 'application/zip', 'Accept-Encoding': 'identity', 'User-Agent': 'Xueness/1'})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError('package download failed; redirects are not followed')
        encoding = response.getheader('Content-Encoding', 'identity').casefold()
        if encoding not in ('', 'identity'):
            raise ValueError('encoded package downloads are not supported')
        length = response.getheader('Content-Length')
        if length is not None and (not length.isdigit() or int(length) > MAX_ARCHIVE_BYTES):
            raise ValueError('package download exceeds archive limit')
        chunks, size = [], 0
        while True:
            for pid in ('extensions', 'network'):
                plugin_runtime.require_enabled(state, pid)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('package download deadline exceeded')
            if connection.sock is not None:
                connection.sock.settimeout(min(15, remaining))
            chunk = response.read(min(65_536, MAX_ARCHIVE_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_ARCHIVE_BYTES:
                raise ValueError('package download exceeds archive limit')
        return b''.join(chunks)
    except OSError:
        raise ValueError('package download failed (details suppressed)') from None
    finally:
        connection.close()
