/**
 * The same checks and timings against the Python backend's own tool
 * handlers (files/builtin_tools.py, shell/tooling.py), called directly with
 * a Gate that allows everything, on the same synthetic workspace.
 */
import { pythonUnavailableReason, runPython } from "../../test-support/python-oracle.ts";
import { MARKER, RARE_REGEX } from "./workspace.ts";

export interface PythonCheck {
  pass: boolean;
  detail: string;
}

export interface PythonBench {
  version: string;
  checks: Record<string, PythonCheck>;
  /** Median milliseconds, with what the call found. */
  speed: Record<string, { ms: number; detail: string }>;
}

const SCRIPT = String.raw`
import inspect, json, statistics, sys, time
from pathlib import Path
from xueness.bundled_plugins.files import builtin_tools as bt
from xueness.bundled_plugins.shell import tooling as sh

class Gate:
    def check(self, *args, **kwargs):
        pass

args = json.loads(sys.stdin.read())
root, n, gate = Path(args['root']), args['iterations'], Gate()
marker, rare = args['marker'], args['rare']

def safe(fn):
    try:
        return fn()
    except Exception as exc:
        return {'ok': False, 'raised': type(exc).__name__}

def timed(fn):
    samples, value = [], None
    for _ in range(n):
        started = time.perf_counter()
        value = safe(fn)
        samples.append((time.perf_counter() - started) * 1000)
    return round(statistics.median(samples), 3), value

out = {'version': sys.version.split()[0], 'checks': {}, 'speed': {}}
edited = safe(lambda: bt._edit(root, gate, {'path': 'fixtures/crlf-python.txt', 'old': 'beta', 'new': 'BETA'}, None, None))
data = (root / 'fixtures' / 'crlf-python.txt').read_bytes()
kept = edited.get('ok') is True and data.count(b'\r\n') == 3
out['checks']['crlf'] = {'pass': kept, 'detail': 'CRLF kept' if kept else 'rewritten: %r' % data[:24]}
read = safe(lambda: bt._read(root, gate, {'path': 'fixtures/gbk.txt'}, None, None))
out['checks']['gbk'] = {'pass': '你好' in str(read.get('output', '')), 'detail': read.get('raised') or str(read.get('output', ''))[:40]}
grep = safe(lambda: bt._grep(root, gate, {'pattern': marker}, None, None))
hits = grep.get('output') or []
deps = sum(1 for hit in hits if hit['path'].startswith('node_modules/'))
ignored = sum(1 for hit in hits if hit['path'].startswith('dist/'))
out['checks']['ignore'] = {'pass': deps == 0 and ignored == 0, 'detail': '%d hits: %d in node_modules, %d gitignored' % (len(hits), deps, ignored)}
missing = safe(lambda: sh._exec(root, gate, {'argv': ['xueness-bench-no-such-command']}, None, None))
out['checks']['missing'] = {'pass': missing.get('error_code') == 'command_not_found', 'detail': str(missing.get('error_code') or missing.get('raised'))}
fixed = 'timeout=30' in inspect.getsource(sh._exec)
out['checks']['timeout'] = {'pass': not fixed, 'detail': 'fixed 30 s, no per-call timeout' if fixed else 'configurable'}

ms, value = timed(lambda: bt._glob(root, gate, {'pattern': '**/*.ts'}, None, None))
out['speed']['glob'] = {'ms': ms, 'detail': '%s files' % value.get('count')}
ms, value = timed(lambda: bt._grep(root, gate, {'pattern': marker}, None, None))
out['speed']['grep_literal'] = {'ms': ms, 'detail': '%s hits' % value.get('count')}
ms, value = timed(lambda: bt._grep(root, gate, {'pattern': rare}, None, None))
out['speed']['grep_regex'] = {'ms': ms, 'detail': '%s hits' % value.get('count')}
ms, value = timed(lambda: bt._read(root, gate, {'path': 'fixtures/big.txt'}, None, None))
out['speed']['read'] = {'ms': ms, 'detail': '%s chars' % len(str(value.get('output', '')))}
state = {'turn': 0}
def edit():
    state['turn'] += 1
    old, new = ('const alpha = 1;', 'const alpha = 2;') if state['turn'] % 2 else ('const alpha = 2;', 'const alpha = 1;')
    return bt._edit(root, gate, {'path': 'fixtures/edit-python.ts', 'old': old, 'new': new}, None, None)
ms, value = timed(edit)
out['speed']['edit'] = {'ms': ms, 'detail': 'ok' if value.get('ok') else str(value.get('raised') or value.get('error'))}
ms, value = timed(lambda: sh._exec(root, gate, {'argv': ['true']}, None, None))
out['speed']['exec'] = {'ms': ms, 'detail': 'exit %s' % value.get('exit_code')}
print(json.dumps(out, ensure_ascii=False))
`;

/** Null and a reason when Python or the backend is not available. */
export function runPythonBench(root: string, iterations: number): { result: PythonBench | null; reason: string | null } {
  const reason = pythonUnavailableReason();
  if (reason) return { result: null, reason };
  try {
    const output = runPython(SCRIPT, JSON.stringify({ root, iterations, marker: MARKER, rare: RARE_REGEX }));
    return { result: JSON.parse(output.trim().split("\n").at(-1) as string) as PythonBench, reason: null };
  } catch (error) {
    return { result: null, reason: `Python bench failed: ${(error as Error).message.split("\n")[0]}` };
  }
}
