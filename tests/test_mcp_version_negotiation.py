"""MCP protocol-version negotiation.

The client asks for one version and must cope with a server that answers
differently. Per the MCP spec, a client that receives a version it does not
support must **disconnect** — an unknown version may use a different wire shape,
and carrying on would mis-parse every later message.

Cases covered here:
1. Server accepts our preferred version -> used as-is.
2. Server rejects it with a JSON-RPC error -> retry on a fresh process, walking
   the ladder newest-first, until one is accepted.
3. Server answers with a version we do not support -> refuse to connect.
4. Server omits ``protocolVersion`` -> refuse to connect.
5. A per-server ``protocolVersion`` pins the first attempt (no wasted retries).
6. A silent/dead server is NOT retried: another version cannot fix a dead pipe.

Every fake server below is a real subprocess speaking newline-delimited
JSON-RPC, so these assert on real behaviour rather than on a mock's opinion.
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from xueness.mcp import (PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS,
                         McpClient)


def _picker_server() -> str:
    """A server that accepts only ``sys.argv[2]``, erroring on every other version.

    The accepted version is passed as a real argv value (see ``_client``) rather
    than interpolated into this source: the source is a raw string full of
    backslash escapes, and splicing a value into it is how you get a child that
    dies with a SyntaxError instead of a protocol answer.
    """
    return r'''
import json, sys
ATT = sys.argv[1]
ACCEPT = sys.argv[2]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        m = json.loads(line)
    except ValueError:
        continue
    mid = m.get("id")
    mth = m.get("method")
    if mth == "initialize":
        asked = (m.get("params") or {}).get("protocolVersion")
        with open(ATT, "a", encoding="utf-8") as fh:
            fh.write(str(asked) + "\n")
        if asked == ACCEPT:
            out = {"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": ACCEPT, "capabilities": {"tools": {}},
                "serverInfo": {"name": "picker", "version": "1"}}}
        else:
            out = {"jsonrpc": "2.0", "id": mid,
                   "error": {"code": -32602, "message": "Unsupported protocol version"}}
    elif mth == "notifications/initialized":
        continue
    elif mth == "tools/list":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"tools": []}}
    else:
        out = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "nf"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
'''


def _echo_version_server(version_json: str) -> str:
    """A server that replies with a literal ``protocolVersion`` JSON fragment."""
    return r'''
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        m = json.loads(line)
    except ValueError:
        continue
    mid = m.get("id")
    mth = m.get("method")
    if mth == "initialize":
        out = {"jsonrpc": "2.0", "id": mid, "result": {
            "capabilities": {"tools": {}}, "serverInfo": {"name": "v", "version": "1"},
            %s}}
    elif mth == "notifications/initialized":
        continue
    else:
        out = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "nf"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
''' % version_json


def _silent_server() -> str:
    """Reads stdin forever, never answers: a dead transport, not a bad version."""
    return r'''
import sys, time
for line in sys.stdin:
    pass
'''


class VersionNegotiationTests(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.work = Path(holder.name)
        self.attempts = self.work / "attempts.txt"

    def _client(self, source: str, accept=None, **kwargs):
        script = self.work / "srv.py"
        script.write_text(source, encoding="utf-8")
        args = [str(script), str(self.attempts)]
        if accept is not None:
            args.append(accept)
        server = {"id": "s", "command": sys.executable, "args": args}
        client = McpClient(server, cwd=self.work, **kwargs)
        self.addCleanup(client.close)
        return client

    def _tried(self) -> list:
        if not self.attempts.exists():
            return []
        return [line for line in self.attempts.read_text(encoding="utf-8").splitlines() if line]

    # -- 1. happy path -----------------------------------------------------

    def test_preferred_version_is_used_when_accepted(self):
        client = self._client(_picker_server(), accept=PROTOCOL_VERSION)
        client.start()
        self.assertIsNone(client.error, client.error)
        self.assertTrue(client.active)
        self.assertEqual(client.negotiated_protocol_version, PROTOCOL_VERSION)
        self.assertEqual(self._tried(), [PROTOCOL_VERSION])

    def test_server_info_and_capabilities_are_recorded(self):
        client = self._client(_picker_server(), accept=PROTOCOL_VERSION)
        client.start()
        self.assertEqual(client.server_info.get("name"), "picker")
        self.assertIn("tools", client.server_capabilities)

    # -- 2. ladder ---------------------------------------------------------

    def test_retries_newest_first_until_the_server_accepts(self):
        """Server only speaks 2025-03-26: the client must walk down to it."""
        client = self._client(_picker_server(), accept="2025-03-26")
        client.start()
        self.assertIsNone(client.error, client.error)
        self.assertTrue(client.active)
        self.assertEqual(client.negotiated_protocol_version, "2025-03-26")
        tried = self._tried()
        self.assertEqual(tried[0], PROTOCOL_VERSION, "must try the preferred version first")
        self.assertEqual(tried[-1], "2025-03-26", "must end on the accepted version")
        # Newest-first after the preferred one, and no repeats.
        self.assertEqual(tried[1:], ["2025-11-25", "2025-06-18", "2025-03-26"])
        self.assertEqual(len(tried), len(set(tried)), "no version tried twice")

    def test_oldest_only_server_is_reached_at_the_end_of_the_ladder(self):
        client = self._client(_picker_server(), accept="2024-11-05")
        client.start()
        # Preferred version is 2024-11-05, so it succeeds immediately.
        self.assertIsNone(client.error, client.error)
        self.assertEqual(self._tried(), ["2024-11-05"])

    def test_gives_up_after_the_whole_ladder(self):
        """A server that rejects every version must fail, not hang or loop."""
        client = self._client(_picker_server(), accept="1999-01-01", timeout=5)
        client.start()
        self.assertFalse(client.active)
        self.assertIsNotNone(client.error)
        tried = self._tried()
        self.assertEqual(len(tried), len(SUPPORTED_PROTOCOL_VERSIONS))
        self.assertEqual(set(tried), set(SUPPORTED_PROTOCOL_VERSIONS))

    # -- 3. unsupported answer --------------------------------------------

    def test_unsupported_answer_version_refuses_to_connect(self):
        client = self._client(_echo_version_server('"protocolVersion": "2099-01-01"'))
        client.start()
        self.assertFalse(client.active, "must not stay connected to an unknown protocol")
        self.assertIn("unsupported protocol version", client.error)
        self.assertIn("2099-01-01", client.error)
        self.assertIsNone(client.negotiated_protocol_version)
        self.assertEqual(client.server_info, {})

    def test_missing_version_refuses_to_connect(self):
        client = self._client(_echo_version_server('"serverInfo": {"name": "x"}'))
        client.start()
        self.assertFalse(client.active)
        self.assertIn("missing protocolVersion", client.error)

    def test_non_string_version_refuses_to_connect(self):
        client = self._client(_echo_version_server('"protocolVersion": 20250326'))
        client.start()
        self.assertFalse(client.active)
        self.assertIsNotNone(client.error)

    # -- 4. pinning --------------------------------------------------------

    def test_per_server_pin_skips_the_ladder(self):
        client = self._client(_picker_server(), accept="2025-06-18", timeout=15)
        client.server["protocolVersion"] = "2025-06-18"
        client.start()
        self.assertIsNone(client.error, client.error)
        self.assertEqual(client.negotiated_protocol_version, "2025-06-18")
        self.assertEqual(self._tried(), ["2025-06-18"], "a pin must not waste attempts")

    def test_unknown_pin_falls_back_to_the_default(self):
        client = self._client(_picker_server(), accept=PROTOCOL_VERSION)
        client.server["protocolVersion"] = "not-a-version"
        client.start()
        self.assertIsNone(client.error, client.error)
        self.assertEqual(self._tried()[0], PROTOCOL_VERSION)

    # -- 5. dead transport is not a version problem ------------------------

    def test_silent_server_is_not_retried(self):
        """A child that never answers must fail once, not spawn four times."""
        client = self._client(_silent_server(), timeout=2)
        client.start()
        self.assertFalse(client.active)
        self.assertIsNotNone(client.error)
        self.assertEqual(self._tried(), [], "a silent server is never asked twice")

    # -- 6. constants ------------------------------------------------------

    def test_default_version_is_supported(self):
        self.assertIn(PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS)

    def test_supported_versions_are_ordered_oldest_first(self):
        self.assertEqual(list(SUPPORTED_PROTOCOL_VERSIONS),
                         sorted(SUPPORTED_PROTOCOL_VERSIONS))


if __name__ == "__main__":
    unittest.main()
