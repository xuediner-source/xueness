"""Runtime profile and JSONL seam regressions."""
import json
import tempfile
import unittest
from pathlib import Path

from xueness.bundled_plugins.runtimes import plugin
from xueness.bundled_plugins.runtimes.runtime import (
    PROFILES,
    PROTOCOL_VERSION,
    decode_request,
    decode_response,
    encode_request,
    encode_response,
    load_selection,
    normalize_selection,
    save_selection,
    provider_profile,
)


class RuntimePluginTests(unittest.TestCase):
    def test_profiles_are_fixed_and_selection_accepts_only_a_profile_string(self):
        self.assertEqual(PROFILES, ("zcode-full", "pi-lite"))
        full = normalize_selection("zcode-full")
        lite = normalize_selection("pi-lite")
        self.assertEqual(full["profile"], "zcode-full")
        # Profile selection keeps the existing loops as the durable execution
        # owners; pi-lite additionally exposes an optional local sidecar seam.
        self.assertEqual(full["loop"], "xueness-standard")
        self.assertIn("xueness-events", full["capabilities"])
        self.assertEqual(lite["profile"], "pi-lite")
        self.assertEqual(lite["loop"], "xueness-lightweight")
        self.assertIn("xueness-agent-loop", lite["capabilities"])
        for value in (None, "", "unknown", {"profile": "zcode-full"}, ["pi-lite"]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_selection(value)
        self.assertEqual(provider_profile("zcode-full"), "standard")
        self.assertEqual(provider_profile("pi-lite"), "lightweight")

    def test_jsonl_request_and_response_round_trip(self):
        request = {"version": PROTOCOL_VERSION, "requestId": "request-1",
                   "sessionId": "session-1", "method": "turn/start", "payload": {"text": "hi"}}
        response = {"version": PROTOCOL_VERSION, "requestId": "request-1",
                    "sessionId": "session-1", "method": "turn/start", "ok": True,
                    "payload": {"status": "accepted"}}
        self.assertEqual(decode_request(encode_request(request)), request)
        self.assertEqual(decode_response(encode_response(response)), response)
        self.assertTrue(encode_request(request).endswith("\n"))
        for line in ("", "{}\n", '{"version": 2}\n', '{"version": 1}\n\n'):
            with self.subTest(line=line), self.assertRaises(ValueError):
                decode_request(line)

    def test_jsonl_rejects_extra_lines_even_after_a_valid_request(self):
        request = {"version": PROTOCOL_VERSION, "requestId": "request-1",
                   "sessionId": "session-1", "method": "turn/start", "payload": {}}
        line = encode_request(request)
        for value in (line + "\n", line + "\n\n", line + "{}\n",
                      line[:-1] + "\r\n", line + "\n "):
            with self.subTest(value=value), self.assertRaises(ValueError):
                decode_request(value)
        self.assertEqual(decode_request(line.encode("utf-8")), request)
        self.assertEqual(decode_request(line[:-1]), request)

    def test_jsonl_rejects_non_json_numbers_and_ambiguous_fields(self):
        prefix = ('{"version":1,"requestId":"request-1","sessionId":"session-1",'
                  '"method":"turn/start",')
        for payload in ('"payload":{"budget":NaN}', '"payload":{"budget":Infinity}',
                        '"payload":{"budget":-Infinity}',
                        '"payload":{"budget":1e999}',
                        '"requestId":"request-2","payload":{}',
                        '"payload":{"tool":{"id":"one","id":"two"}}'):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                decode_request(prefix + payload + '}\n')

    def test_response_requires_one_consistent_outcome(self):
        base = {"version": PROTOCOL_VERSION, "requestId": "request-1",
                "sessionId": "session-1", "method": "turn/start", "payload": {}}
        for response in (
            base,
            {**base, "ok": True, "error": {"code": "x", "message": "bad"}},
            {**base, "ok": False},
        ):
            with self.subTest(response=response), self.assertRaises(ValueError):
                decode_response(json.dumps(response) + "\n")
        self.assertEqual(decode_response(json.dumps({**base, "ok": True}) + "\n")["ok"], True)
        failed = {**base, "ok": False, "error": {"code": "turn.failed", "message": "bad"}}
        self.assertFalse(decode_response(json.dumps(failed) + "\n")["ok"])

    def test_profile_selection_is_atomic_and_survives_reload(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            self.assertEqual(load_selection(state), "zcode-full")
            selected = save_selection(state, "pi-lite")
            self.assertEqual(selected["profile"], "pi-lite")
            self.assertEqual(load_selection(state), "pi-lite")
            document = json.loads((state / "runtime-state.json").read_text(encoding="utf-8"))
            self.assertEqual(document, {"apiVersion": PROTOCOL_VERSION, "profile": "pi-lite"})

    def test_http_get_and_select_are_owned_by_runtime_plugin(self):
        with tempfile.TemporaryDirectory() as temp:
            ctx = {"state_dir": Path(temp)}
            code, body = plugin.dispatch("GET", ["api", "runtimes"], {}, {}, ctx)
            self.assertEqual(code, 200)
            self.assertEqual(body["active"], "zcode-full")
            self.assertEqual({row["profile"] for row in body["profiles"]}, set(PROFILES))
            code, body = plugin.dispatch("POST", ["api", "runtimes", "select"], {}, {"profile": "pi-lite"}, ctx)
            self.assertEqual(code, 200)
            self.assertEqual(body["active"], "pi-lite")
            code, body = plugin.dispatch("POST", ["api", "runtimes", "select"], {}, {"profile": "unknown"}, ctx)
            self.assertEqual(code, 400)
            self.assertIsNone(plugin.dispatch("GET", ["api", "other"], {}, {}, ctx))


if __name__ == "__main__":
    unittest.main()
