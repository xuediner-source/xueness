#!/usr/bin/env python3
"""Verify (and optionally repair) ``file:line`` citations in review docs.

Why this exists: hand-maintained line numbers go stale every time the code is
edited. That has now happened three times, and each time the document silently
started lying about the code -- worse than having no citation at all, because it
looks verified.

The checker works on *content*, not just range. For each ``path:line`` citation
it looks at the prose that immediately follows (up to the next citation), finds
the code token the prose claims is there, and requires that token within a
proximity window. Pointing at an in-range but wrong line is reported as STALE.

Usage:
    python3 tools/check_doc_citations.py              # report only
    python3 tools/check_doc_citations.py --fix        # rewrite line numbers
    python3 tools/check_doc_citations.py --doc PATH   # another document

``--fix`` only rewrites a citation whose claimed token matches exactly one line
in the file; ambiguous or unfindable citations are left alone and reported, so
the tool can never silently invent a location.

Known false-positive classes (verified by hand, left in on purpose so the tool
stays simple rather than clever):

* Token bleed on long lines: with several citations in one sentence, a symbol
  belonging to citation A can be attributed to citation B.
* Usage-example tokens: a claim like ``disallow_tools=mcp`` names the *caller's*
  spelling, which need not appear in the cited file at all.

Both produce at most a handful of entries on this document; treat the report as
"needs a human look", not "automatically wrong".
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# ``path:line`` or ``path:line-line``.
CITATION = re.compile(r"([A-Za-z0-9_./@-]+\.(?:py|ts|tsx|mjs|js|md|json)):(\d+)(?:-(\d+))?")
# A bare ``:line`` continues the most recently named file (common in prose that
# lists several spots inside one file). The lookbehind excludes Python slices
# like ``[:200]``, which are not citations.
BARE_REF = re.compile(r"(?<![A-Za-z0-9_./\[-]):(\d+)(?:-(\d+))?")
# Backticked spans, e.g. ``TIMEOUT_CAP = 30``.
TOKEN = re.compile(r"`([^`\n]+)`")

# Words that appear in prose and code alike; a citation pointing at one of these
# proves nothing. The first version of this checker flagged ``error``/``None``
# and buried the real staleness in noise.
GENERIC = {
    "none", "true", "false", "error", "plan", "build", "name", "path", "kind",
    "subject", "session", "result", "value", "list", "dict", "str", "int",
    "json", "self", "return", "import", "def", "class", "and", "the", "not",
    "for", "with", "from", "else", "elif", "raise", "pass", "line", "file",
    "api", "get", "post", "put", "patch", "delete",
}

#: How many lines either side of the cited line a claimed symbol may live.
WINDOW = 25


def symbol_of(token: str) -> str:
    """The bare symbol a prose token refers to.

    ``TIMEOUT_CAP = 30`` -> ``TIMEOUT_CAP``; ``gate.check("mcp", ...)`` ->
    ``gate.check``; ``shell=False`` -> ``shell``.
    """
    key = token.split("(")[0].split("=")[0].strip()
    return key.strip("\"'")


def symbol_variants(token: str) -> list[str]:
    """Acceptable spellings of a prose token in source.

    Prose writes qualified names (``_NullStore.save``, ``gate.check``,
    ``_NoRedirect.redirect_request``) while the code has ``class _NullStore`` and
    ``def save`` on separate lines. Requiring the full dotted string produced
    false positives on every such claim, so the last component counts too.
    """
    key = symbol_of(token)
    out = [key]
    if "." in key:
        tail = key.rsplit(".", 1)[1]
        if len(tail) >= 4:
            out.append(tail)
    return out


def is_distinctive(token: str) -> bool:
    """A token worth checking: specific enough that a wrong line cannot match.

    ASCII-only on purpose: prose spans in the docs are Chinese, and treating a
    backticked sentence as a code claim produced pure noise.
    """
    if not token.isascii():
        return False
    key = symbol_of(token)
    if not key.isascii():
        return False
    if len(key) < 4 or key.lower() in GENERIC:
        return False
    if key.isupper():
        return True
    if "(" in token:
        return True
    if re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)+", key):
        return True
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+", key):
        return True
    return False


def load_lines(path: str) -> list[str] | None:
    p = Path(path)
    if not p.exists():
        return None
    return p.read_text(encoding="utf-8", errors="replace").splitlines()


def find_line_for_token(lines: list[str], token: str) -> list[int]:
    hits: set[int] = set()
    for variant in symbol_variants(token):
        if len(variant) < 4:
            continue
        hits |= {i + 1 for i, line in enumerate(lines) if variant in line}
    return sorted(hits)


def citations_in_line(line: str) -> list[tuple[int, int, str, int]]:
    """All ``(start, end, path, line_no)`` refs, resolving bare ``:line`` forms.

    Prose often writes ``\u0060xueness/core.py:110\u0060 (\u0060CONST\u0060), \u0060:120\u0060 (\u0060other\u0060)``.
    Treating the bare form as belonging to the previous file is what makes the
    claim attribution correct; without it every later token is blamed on the
    first citation and the report fills with false positives.
    """
    out: list[tuple[int, int, str, int]] = []
    last_path: str | None = None
    events = []
    for m in CITATION.finditer(line):
        events.append((m.start(), m.end(), m.group(1), int(m.group(2))))
    for m in BARE_REF.finditer(line):
        events.append((m.start(), m.end(), None, int(m.group(1))))
    for start, end, path, lineno in sorted(events):
        if path is not None:
            last_path = path
        elif last_path is not None:
            path = last_path
        else:
            continue
        out.append((start, end, path, lineno))
    return out


def claims_in_line(line: str) -> list[tuple[int, int, str, int, list[str]]]:
    """Parse one doc line into (start, end, path, line_no, claim_tokens).

    Each backticked code token is attributed to the **nearest** citation by
    character distance, because the docs use both orders:

        ``\u0060path:110\u0060 (\u0060CONST\u0060)``      cite, then name
        \u0060CONST\u0060 (\u0060path:110\u0060)      name, then cite

    Assuming a single direction (or using ``list.index`` on possibly-equal
    tuples) mis-blames tokens on chained citations and fills the report with
    false positives -- which is how a checker gets ignored, and a stale document
    then ships.
    """
    refs = citations_in_line(line)
    if not refs:
        return []
    tokens = [(t.start(), t.end(), t.group(1))
              for t in TOKEN.finditer(line) if is_distinctive(t.group(1))]
    assigned: list[list[str]] = [[] for _ in refs]
    for ts, te, tok in tokens:
        if any(s <= ts and te <= e for s, e, _p, _l in refs):
            continue  # the citation's own backticked text
        best_i = best_d = None
        for i, (s, e, _p, _l) in enumerate(refs):
            d = min(abs(ts - e), abs(s - te))
            if best_d is None or d < best_d:
                best_d, best_i = d, i
        if best_i is not None:
            assigned[best_i].append(tok)
    return [(s, e, p, l, assigned[i]) for i, (s, e, p, l) in enumerate(refs)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", default="reviews/security-posture-change.md")
    ap.add_argument("--fix", action="store_true", help="rewrite unambiguous line numbers")
    args = ap.parse_args()

    doc_path = Path(args.doc)
    if not doc_path.exists():
        print("no such document: %s" % doc_path, file=sys.stderr)
        return 2
    original = doc_path.read_text(encoding="utf-8")
    lines = original.splitlines()

    cache: dict[str, list[str] | None] = {}

    def get(p):
        if p not in cache:
            cache[p] = load_lines(p)
        return cache[p]

    stale: list[tuple[str, int, str, list[int], int, int, int]] = []
    missing: list[tuple[str, int]] = []
    checked = 0

    for line in lines:
        # Struck-through text records history ("this used to say X"); its line
        # numbers describe a revision that no longer exists, so checking them
        # would only produce permanent noise.
        if "~~" in line:
            continue
        for start, end, path, lineno, tokens in claims_in_line(line):
            if not tokens:
                continue
            src = get(path)
            if src is None:
                missing.append((path, lineno))
                continue
            checked += 1
            if lineno > len(src):
                stale.append((path, lineno, tokens[0][:40], [], start, end, len(tokens[0])))
                continue
            lo = max(0, lineno - 1 - WINDOW)
            hi = min(len(src), lineno - 1 + WINDOW)
            nearby = "\n".join(src[lo:hi])
            if any(v in nearby for t in tokens for v in symbol_variants(t)):
                continue
            cands = sorted({c for t in tokens for c in find_line_for_token(src, t)})
            stale.append((path, lineno, tokens[0][:40], cands, start, end, len(tokens[0])))

    print("=== %d cited claim(s) checked across %d line(s) ===" % (checked, len(lines)))
    if missing:
        print("\nMISSING FILES:")
        for path, ln in missing:
            print("  %s:%d" % (path, ln))
    if not stale:
        print("\nno stale citations")
        return 0

    print("\nSTALE (%d):" % len(stale))
    for path, ln, want, cands, _s, _e, _n in stale:
        print("  %-34s claimed=%r" % ("%s:%d" % (path, ln), want))
        print("      candidate line(s): %s" % (cands if cands else "none found"))

    if not args.fix:
        return 1

    # Rewrite per line, in reverse span order, so one repair cannot shift the
    # offsets of another on the same line. Only unambiguous citations move.
    replacement_map = {(p, l): c[0] for p, l, _w, c, _s, _e, _n in stale if len(c) == 1}
    if not replacement_map:
        print("\nnothing unambiguous to fix")
        return 1
    rebuilt = []
    for line in lines:
        for start, end, path, lineno, _tokens in reversed(claims_in_line(line)):
            new = replacement_map.get((path, lineno))
            if new is None:
                continue
            line = line[:start] + "%s:%d" % (path, new) + line[end:]
        rebuilt.append(line)
    doc_path.write_text("\n".join(rebuilt) + "\n", encoding="utf-8")
    print("\nrewrote %d citation(s); re-run to confirm" % len(replacement_map))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
