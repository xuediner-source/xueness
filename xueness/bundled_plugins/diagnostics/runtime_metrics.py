"""Bounded, local-only process and host resource sampling for diagnostics."""
from __future__ import annotations

import copy
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import threading
import time
from datetime import datetime, timezone

from ...process_runtime import run_external

try:
    import resource
except ImportError:  # Windows has no resource module; probes become unavailable.
    resource = None

SCHEMA = "xueness.runtime-metrics.v1"
SAMPLE_SECONDS = 2.0
COMMAND_TIMEOUT_SECONDS = 0.5
GPU_UNAVAILABLE_REASON = "GPU 内存遥测不可用于本地运行时采样。"
_MAX_BYTES = 1 << 60
_MAX_CACHE_ENTRIES = 64
_CACHE_GUARD = threading.Lock()
_CACHES: dict[object, "_ContextCache"] = {}


class _ContextCache:
    def __init__(self):
        self.lock = threading.Lock()
        self.sampled_at = 0.0
        self.value: dict | None = None
        self.cpu_baseline: tuple[float, float] | None = None


def _cache_key(ctx: dict) -> object:
    # Handler contexts are shallow copies of the server context, so Store is a
    # stable identity for that runtime while still keeping independent servers
    # separate. A path fallback supports small direct plugin contexts/tests.
    store = ctx.get("store")
    if store is not None:
        try:
            hash(store)
            return ("store", store)
        except TypeError:
            return ("store-id", id(store))
    try:
        return ("state", str(Path(ctx["state_dir"]).resolve()))
    except (KeyError, OSError, RuntimeError, TypeError, ValueError):
        return ("context", id(ctx))


def _context_cache(ctx: dict) -> _ContextCache:
    key = _cache_key(ctx)
    with _CACHE_GUARD:
        cache = _CACHES.get(key)
        if cache is None:
            cache = _ContextCache()
            _CACHES[key] = cache
            if len(_CACHES) > _MAX_CACHE_ENTRIES:
                # Drop the oldest insertion. Cache entries contain no user data.
                _CACHES.pop(next(iter(_CACHES)))
        return cache


def _bounded_int(raw, *, multiplier: int = 1) -> int | None:
    try:
        value = int(raw) * multiplier
    except (TypeError, ValueError, OverflowError):
        return None
    return value if 0 <= value <= _MAX_BYTES else None


def _run_fixed(argv: list[str]) -> str | None:
    """Run a fixed, non-shell system query and discard all failures quietly."""
    try:
        completed = run_external(
            subprocess.run,
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
            close_fds=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
        if completed.returncode != 0 or not isinstance(completed.stdout, str):
            return None
        return completed.stdout[:65536]
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
        return None


def _read_linux_meminfo(path: Path = Path("/proc/meminfo")) -> tuple[int | None, int | None, str | None]:
    try:
        # The kernel proc file is bounded in practice; cap reads to avoid an
        # unexpected alternate path or test fixture consuming unbounded memory.
        with path.open("rb") as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            return None, None, None
        lines = raw.decode("ascii", errors="strict").splitlines()
    except (OSError, UnicodeError, ValueError):
        return None, None, None
    values: dict[str, int] = {}
    for line in lines:
        match = re.fullmatch(r"([A-Za-z_()]+):\s*([0-9]{1,18})\s*kB", line.strip())
        if match:
            value = _bounded_int(match.group(2), multiplier=1024)
            if value is not None:
                values[match.group(1)] = value
    total = values.get("MemTotal")
    if "MemAvailable" in values:
        available = values["MemAvailable"]
        return total, min(available, total) if total is not None else available, "kernel_estimate"
    free = values.get("MemFree")
    if free is None:
        return total, None, None
    reclaimable = sum(values.get(key, 0) for key in ("Buffers", "Cached", "SReclaimable"))
    reclaimable -= values.get("Shmem", 0)
    available = min(_MAX_BYTES, max(0, free + reclaimable))
    if total is not None:
        available = min(available, total)
    return total, available, "free_plus_reclaimable_estimate"


def _read_linux_rss(page_size: int, path: Path = Path("/proc/self/statm")) -> int | None:
    try:
        with path.open("rb") as stream:
            raw = stream.read(256)
        fields = raw.decode("ascii", errors="strict").split()
        if len(fields) < 2 or not fields[1].isdigit():
            return None
        return _bounded_int(fields[1], multiplier=page_size)
    except (OSError, UnicodeError, ValueError):
        return None


def _parse_vm_stat(text: str) -> tuple[int | None, str | None]:
    page_match = re.search(r"^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)", text, re.M)
    if not page_match:
        return None, None
    page_size = _bounded_int(page_match.group(1))
    if not page_size or page_size > (1 << 24):
        return None, None
    pages: dict[str, int] = {}
    for line in text.splitlines():
        match = re.match(r"^Pages ([A-Za-z ]+):\s*([0-9]+)\.?$", line)
        if match:
            count = _bounded_int(match.group(2))
            if count is not None:
                pages[match.group(1).strip().lower()] = count
    if "free" not in pages:
        return None, None
    available_pages = pages["free"] + sum(pages.get(name, 0) for name in ("inactive", "speculative", "purgeable"))
    return _bounded_int(available_pages, multiplier=page_size), "free_plus_reclaimable_estimate"


def _darwin_memory() -> tuple[int | None, int | None, str | None, int | None]:
    total_raw = _run_fixed(["/usr/sbin/sysctl", "-n", "hw.memsize"])
    total = _bounded_int(total_raw.strip()) if total_raw else None
    vm = _run_fixed(["/usr/bin/vm_stat"])
    available, kind = _parse_vm_stat(vm) if vm else (None, None)
    if total is not None and available is not None:
        available = min(available, total)
    rss_raw = _run_fixed(["/bin/ps", "-o", "rss=", "-p", str(os.getpid())])
    rss = _bounded_int(rss_raw.strip(), multiplier=1024) if rss_raw and rss_raw.strip().isdigit() else None
    return total, available, kind, rss


def _memory() -> tuple[int | None, int | None, str | None, int | None]:
    system = platform.system()
    if system == "Darwin":
        return _darwin_memory()
    if system == "Windows":
        from .windows_metrics import memory
        return memory()
    if system == "Linux":
        total, available, kind = _read_linux_meminfo()
        try:
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            if not 0 < page_size <= (1 << 24):
                page_size = 4096
        except (OSError, ValueError, TypeError, AttributeError):
            page_size = 4096
        return total, available, kind, _read_linux_rss(page_size)
    return None, None, None, None


def _disk(state_dir) -> tuple[int | None, int | None]:
    try:
        if os.name == 'nt':
            import shutil
            usage = shutil.disk_usage(state_dir)
            return usage.total, usage.free
        stats = os.statvfs(state_dir)
        block_size = _bounded_int(stats.f_frsize or stats.f_bsize)
        if not block_size:
            return None, None
        total = _bounded_int(stats.f_blocks, multiplier=block_size)
        available = _bounded_int(stats.f_bavail, multiplier=block_size)
        return total, available
    except (OSError, TypeError, ValueError, AttributeError):
        return None, None


def _load_average() -> list[float | None]:
    try:
        values = os.getloadavg()
    except (AttributeError, OSError):
        return [None, None, None]
    result: list[float | None] = []
    for value in values[:3]:
        try:
            number = float(value)
            result.append(number if math.isfinite(number) and 0 <= number <= 1_000_000 else None)
        except (TypeError, ValueError, OverflowError):
            result.append(None)
    return (result + [None, None, None])[:3]


def _process_cpu_sample() -> tuple[float, float] | None:
    if resource is None:
        if os.name == 'nt':
            return time.monotonic(), time.process_time()
        return None
    try:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        cpu = float(usage.ru_utime) + float(usage.ru_stime)
        now = time.monotonic()
        if math.isfinite(cpu) and cpu >= 0 and math.isfinite(now):
            return now, cpu
    except (AttributeError, OSError, TypeError, ValueError, OverflowError):
        pass
    return None


def _process_percent(cache: _ContextCache, sample: tuple[float, float] | None, logical_cores: int | None) -> float | None:
    if sample is None:
        return None
    previous = cache.cpu_baseline
    cache.cpu_baseline = sample
    if previous is None:
        return None
    elapsed = sample[0] - previous[0]
    cpu_elapsed = sample[1] - previous[1]
    if elapsed <= 0 or cpu_elapsed < 0:
        return None
    value = cpu_elapsed / elapsed * 100.0
    if not math.isfinite(value) or value < 0:
        return None
    if logical_cores is not None:
        value = min(value, logical_cores * 100.0)
    return round(value, 2)


def _sample(ctx: dict, cache: _ContextCache) -> dict:
    before = _process_cpu_sample()
    cores = None
    try:
        value = os.cpu_count()
        if type(value) is int and 0 < value <= 65536:
            cores = value
    except (OSError, TypeError, ValueError):
        pass
    try:
        total, available, available_kind, rss = _memory()
    except Exception:
        total, available, available_kind, rss = None, None, None, None
    try:
        disk_total, disk_available = _disk(ctx.get("state_dir"))
    except Exception:
        disk_total, disk_available = None, None
    cpu = _process_percent(cache, _process_cpu_sample() or before, cores)
    sampled_at = datetime.now(timezone.utc).isoformat()
    try:
        load = _load_average()
    except Exception:
        load = [None, None, None]
    return {
        "schema": SCHEMA,
        "sampledAtISO": sampled_at,
        "samplingSeconds": SAMPLE_SECONDS,
        "cpu": {"logicalCores": cores, "loadAverage": load, "processPercent": cpu},
        "memory": {
            "totalBytes": total,
            "availableBytes": available,
            "availableKind": available_kind,
            "processRssBytes": rss,
        },
        "disk": {"totalBytes": disk_total, "availableBytes": disk_available},
        "gpu": {"available": False, "reason": GPU_UNAVAILABLE_REASON},
    }


def snapshot(ctx: dict) -> dict:
    """Return a cached best-effort snapshot; individual probe failures are null."""
    cache = _context_cache(ctx)
    with cache.lock:
        now = time.monotonic()
        if cache.value is not None and now - cache.sampled_at < SAMPLE_SECONDS:
            return copy.deepcopy(cache.value)
        try:
            value = _sample(ctx, cache)
        except Exception:
            # Host telemetry is optional diagnostics data and must never make
            # the endpoint fail. Preserve a complete schema with null fields.
            value = {
                "schema": SCHEMA,
                "sampledAtISO": datetime.now(timezone.utc).isoformat(),
                "samplingSeconds": SAMPLE_SECONDS,
                "cpu": {"logicalCores": None, "loadAverage": [None, None, None], "processPercent": None},
                "memory": {"totalBytes": None, "availableBytes": None, "availableKind": None, "processRssBytes": None},
                "disk": {"totalBytes": None, "availableBytes": None},
                "gpu": {"available": False, "reason": GPU_UNAVAILABLE_REASON},
            }
        cache.sampled_at = time.monotonic()
        cache.value = value
        return copy.deepcopy(value)
