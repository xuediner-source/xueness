"""Measured request activity, separate from token estimates and completions."""
import math
import time
from datetime import datetime, timezone

PHASES = frozenset({'waiting_model', 'generating', 'thinking', 'tools', 'repairing',
                    'completed', 'needs_review', 'paused', 'stopped', 'stalled',
                    'awaiting_user', 'provider_error', 'interrupted'})
COUNTS = ('requestStep', 'outputChars', 'reasoningChars', 'reportedOutputTokens')
TIMES = ('firstOutputSeconds', 'firstReasoningSeconds', 'requestSeconds', 'charactersPerSecond', 'tokensPerSecond')


def public_activity(raw):
    if not isinstance(raw, dict) or raw.get('phase') not in PHASES:
        return None
    result = {'phase': raw['phase']}
    for key in COUNTS:
        value = raw.get(key)
        if type(value) is int and 0 <= value <= 1_000_000_000:
            result[key] = value
    for key in TIMES:
        value = raw.get(key)
        if type(value) in (int, float) and 0 <= value <= 1_000_000_000 and math.isfinite(value):
            result[key] = value
    started = raw.get('startedAt')
    if isinstance(started, str) and len(started) <= 40:
        try:
            datetime.fromisoformat(started)
            result['startedAt'] = started
        except ValueError:
            pass
    return result


class RequestActivity:
    def __init__(self, session):
        self.session = session
        self.started = time.monotonic()
        self.first_output = None
        self.record = {'phase': 'waiting_model', 'startedAt': datetime.now(timezone.utc).isoformat(),
                       'requestStep': session.get('steps', 0) + 1, 'outputChars': 0}
        session['runtime_activity'] = self.record

    def phase(self, value):
        if value in PHASES:
            self.record['phase'] = value

    def delta(self, text, *, reasoning=False):
        elapsed = max(0, time.monotonic() - self.started)
        self.phase('thinking' if reasoning else 'generating')
        count_key = 'reasoningChars' if reasoning else 'outputChars'
        first_key = 'firstReasoningSeconds' if reasoning else 'firstOutputSeconds'
        self.record[count_key] = min(1_000_000_000, self.record.get(count_key, 0) + len(text))
        self.record.setdefault(first_key, round(elapsed, 4))
        self.record['requestSeconds'] = round(elapsed, 4)
        if not reasoning:
            if self.first_output is None:
                self.first_output = elapsed
            if elapsed > 0:
                self.record['charactersPerSecond'] = round(self.record['outputChars'] / elapsed, 3)

    def complete(self, response, usage):
        elapsed = max(0, time.monotonic() - self.started)
        self.record['requestSeconds'] = round(elapsed, 4)
        if not self.record['outputChars'] and isinstance(response, dict):
            content = response.get('content')
            if isinstance(content, str):
                self.record['outputChars'] = min(1_000_000_000, len(content))
        if elapsed > 0 and self.record['outputChars']:
            self.record['charactersPerSecond'] = round(self.record['outputChars'] / elapsed, 3)
        if isinstance(usage, dict):
            tokens = usage.get('output_tokens', usage.get('completion_tokens'))
            if type(tokens) is int and 0 <= tokens <= 1_000_000_000:
                self.record['reportedOutputTokens'] = tokens
                if elapsed > 0:
                    self.record['tokensPerSecond'] = round(tokens / elapsed, 3)
        self.phase('tools' if isinstance(response, dict) and response.get('tool_calls') else 'generating')
        history = self.session.setdefault('runtime_activity_history', [])
        if not isinstance(history, list):
            history = []
            self.session['runtime_activity_history'] = history
        history.append(dict(self.record))
        del history[:-24]


def settle_activity(session):
    record = session.get('runtime_activity')
    status = session.get('status')
    if isinstance(record, dict) and status in PHASES:
        record['phase'] = status
