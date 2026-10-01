"""Local-only runtime diagnostics sampling, cache and HTTP boundaries."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from xueness import web
from xueness.bundled_plugins.diagnostics import runtime_metrics
from xueness.plugin_runtime import set_enabled


class RuntimeMetricParsing(unittest.TestCase):
    def setUp(self):
        with runtime_metrics._CACHE_GUARD:
            runtime_metrics._CACHES.clear()

    def test_linux_meminfo_uses_kernel_estimate_and_fallback_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meminfo"
            path.write_text("MemTotal:       4096000 kB\nMemAvailable:   1024000 kB\nMemFree:         512000 kB\n", encoding="ascii")
            self.assertEqual(runtime_metrics._read_linux_meminfo(path), (4096000 * 1024, 1024000 * 1024, "kernel_estimate"))
            path.write_text("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 20 kB\nCached: 50 kB\nSReclaimable: 10 kB\nShmem: 5 kB\n", encoding="ascii")
            self.assertEqual(runtime_metrics._read_linux_meminfo(path), (1000 * 1024, 175 * 1024, "free_plus_reclaimable_estimate"))

    def test_actual_process_and_filesystem_probes_are_local_and_bounded(self):
        self.assertIsNotNone(runtime_metrics._process_cpu_sample())
        with tempfile.TemporaryDirectory() as directory:
            total, available = runtime_metrics._disk(directory)
            self.assertIsInstance(total, int)
            self.assertIsInstance(available, int)
            self.assertGreater(total, 0)
            self.assertGreaterEqual(available, 0)
        if Path("/proc/self/statm").exists():
            rss = runtime_metrics._read_linux_rss(os.sysconf("SC_PAGE_SIZE"))
            self.assertIsInstance(rss, int)
            self.assertGreater(rss, 0)
        with tempfile.TemporaryDirectory() as directory:
            statm = Path(directory) / "statm"
            statm.write_text("100 20 0 0\n", encoding="ascii")
            self.assertEqual(runtime_metrics._read_linux_rss(4096, statm), 20 * 4096)

    def test_darwin_uses_bounded_fixed_commands_and_reports_estimated_available(self):
        calls = []

        def fake_run(argv, **kwargs):
            calls.append((argv, kwargs))
            if "sysctl" in argv[0]:
                output = "17179869184\n"
            elif "vm_stat" in argv[0]:
                output = ("Mach Virtual Memory Statistics: (page size of 4096 bytes)\n"
                          "Pages free: 10.\nPages inactive: 20.\nPages speculative: 3.\nPages purgeable: 2.\n")
            else:
                output = "8192\n"
            return subprocess.CompletedProcess(argv, 0, stdout=output, stderr="")

        with patch.object(runtime_metrics.platform, "system", return_value="Darwin"), \
             patch.object(runtime_metrics.subprocess, "run", side_effect=fake_run), \
             patch.object(runtime_metrics.os, "getpid", return_value=4321):
            total, available, kind, rss = runtime_metrics._memory()
        self.assertEqual(total, 16 * 1024**3)
        self.assertEqual(available, 35 * 4096)
        self.assertEqual(kind, "free_plus_reclaimable_estimate")
        self.assertEqual(rss, 8 * 1024 * 1024)
        self.assertEqual(calls[-1][0], ["/bin/ps", "-o", "rss=", "-p", "4321"])
        for argv, kwargs in calls:
            self.assertIsInstance(argv, list)
            self.assertLessEqual(kwargs["timeout"], 0.5)
            self.assertNotIn("shell", kwargs)

    def test_linux_memory_branch_keeps_kernel_kind_and_only_reads_self_rss(self):
        with patch.object(runtime_metrics.platform, "system", return_value="Linux"), \
             patch.object(runtime_metrics, "_read_linux_meminfo", return_value=(8 * 1024**3, 3 * 1024**3, "kernel_estimate")), \
             patch.object(runtime_metrics, "_read_linux_rss", return_value=256 * 1024**2) as rss_probe, \
             patch.object(runtime_metrics.os, "sysconf", return_value=4096):
            values = runtime_metrics._memory()
        self.assertEqual(values, (8 * 1024**3, 3 * 1024**3, "kernel_estimate", 256 * 1024**2))
        rss_probe.assert_called_once_with(4096)

    def test_probe_errors_return_partial_null_fields_instead_of_raising(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = {"state_dir": directory}
            with patch.object(runtime_metrics, "_memory", side_effect=OSError("probe failed")), \
             patch.object(runtime_metrics, "_load_average", side_effect=OSError("load failed")), \
                 patch.object(runtime_metrics, "_disk", return_value=(1024, 512)), \
                 patch.object(runtime_metrics, "_process_cpu_sample", return_value=None):
                result = runtime_metrics.snapshot(ctx)
        self.assertEqual(result["schema"], "xueness.runtime-metrics.v1")
        self.assertEqual(result["cpu"]["loadAverage"], [None, None, None])
        self.assertIsNone(result["memory"]["totalBytes"])
        self.assertEqual(result["disk"], {"totalBytes": 1024, "availableBytes": 512})
        self.assertEqual(result["gpu"]["available"], False)
        self.assertTrue(result["gpu"]["reason"])

    def test_process_percent_is_delta_and_one_core_is_one_hundred_percent(self):
        cache = runtime_metrics._ContextCache()
        self.assertIsNone(runtime_metrics._process_percent(cache, (10.0, 2.0), 4))
        self.assertEqual(runtime_metrics._process_percent(cache, (12.0, 4.0), 4), 100.0)
        self.assertIsNone(runtime_metrics._process_percent(cache, (13.0, 3.0), 4))

    def test_cache_is_per_context_and_returns_copies_for_two_seconds(self):
        first_ctx = {"state_dir": "/tmp/runtime-metrics-test-one"}
        second_ctx = {"state_dir": "/tmp/runtime-metrics-test-two"}
        sample = {"schema": "xueness.runtime-metrics.v1", "nested": {"value": 1}}
        with patch.object(runtime_metrics, "_sample", return_value=sample) as sampler:
            one = runtime_metrics.snapshot(first_ctx)
            one["nested"]["value"] = 99
            two = runtime_metrics.snapshot(first_ctx)
            self.assertEqual(two["nested"]["value"], 1)
            self.assertEqual(sampler.call_count, 1)
            runtime_metrics._context_cache(first_ctx).sampled_at -= 2.1
            runtime_metrics.snapshot(first_ctx)
            self.assertEqual(sampler.call_count, 2)
            runtime_metrics.snapshot(second_ctx)
            self.assertEqual(sampler.call_count, 3)

    def test_concurrent_requests_share_one_sample_for_the_context(self):
        ctx = {"state_dir": "/tmp/runtime-metrics-concurrency"}
        value = {"schema": "xueness.runtime-metrics.v1"}
        with patch.object(runtime_metrics, "_sample", return_value=value) as sampler:
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: runtime_metrics.snapshot(ctx), range(8)))
        self.assertEqual(sampler.call_count, 1)
        self.assertTrue(all(result == value for result in results))


class RuntimeMetricsHTTP(unittest.TestCase):
    def setUp(self):
        with runtime_metrics._CACHE_GUARD:
            runtime_metrics._CACHES.clear()
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / "state", base / "work", base / "project")
        self.server = web.create_server(0, self.ctx)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_address[1])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, path, *, host=None, origin=None):
        headers = {}
        if host:
            headers["Host"] = host
        if origin:
            headers["Origin"] = origin
        request = urllib.request.Request(self.base + path, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def test_runtime_route_is_local_diagnostics_plugin_gated_and_host_checked(self):
        status, response = self.request("/api/diagnostics/runtime")
        self.assertEqual(status, 200)
        self.assertEqual(response["schema"], "xueness.runtime-metrics.v1")
        self.assertEqual(response["samplingSeconds"], 2.0)
        self.assertEqual(set(response["cpu"]), {"logicalCores", "loadAverage", "processPercent"})
        self.assertEqual(response["gpu"]["available"], False)
        status, denied = self.request("/api/diagnostics/runtime", host="not-local.example")
        self.assertEqual(status, 403)
        self.assertIn("error", denied)
        self.assertEqual(self.request("/api/diagnostics/runtime", origin="https://not-local.example")[0], 403)
        set_enabled(self.ctx["state_dir"], "diagnostics", False)
        self.assertEqual(self.request("/api/diagnostics/runtime")[0], 403)

    def test_http_probe_failure_still_returns_schema_with_nulls(self):
        with patch.object(runtime_metrics, "_sample", side_effect=RuntimeError("private failure text")):
            status, response = self.request("/api/diagnostics/runtime")
        self.assertEqual(status, 200)
        self.assertEqual(response["schema"], "xueness.runtime-metrics.v1")
        self.assertIsNone(response["memory"]["totalBytes"])
        self.assertNotIn("private failure text", json.dumps(response))


if __name__ == "__main__":
    unittest.main()
