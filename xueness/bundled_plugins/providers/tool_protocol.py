"""Lossless protocol parsing and bounded, content-free failure diagnostics.

Never extract an executable call from prose or guess missing arguments. A
malformed response has no durable intent; the host may request a fresh reply.
"""
import hashlib
import json
import re

DIAGNOSTIC_CODES = frozenset({'wrong_protocol', 'missing_text', 'invalid_json', 'duplicate_json_key',
    'invalid_envelope', 'invalid_json_value', 'tool_unavailable', 'invalid_native_envelope',
    'duplicate_call_id', 'invalid_native_arguments'})


class DuplicateKey(ValueError):
    pass


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKey('duplicate JSON key')
        result[key] = value
    return result


def _nonfinite(_value):
    raise ValueError('nonfinite JSON number')


def strict_json(text):
    return json.loads(text, object_pairs_hook=_unique_object, parse_constant=_nonfinite)


def arguments_object(text):
    value = strict_json(text)
    if not isinstance(value, dict):
        raise ValueError('tool arguments must be an object')
    json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
    return value


def envelope_text(content):
    """Accept a BOM or one complete JSON fence, preserving the payload verbatim."""
    text = content.strip().removeprefix('\ufeff').strip()
    fence = re.fullmatch(r'```(?:json)?[ \t]*\r?\n(.*)\r?\n```', text,
                         flags=re.DOTALL | re.IGNORECASE)
    return fence.group(1).strip() if fence else text


def failure(response, code, instruction, *, error=None):
    content = response.get('content')
    diagnostic = {'code': code}
    if isinstance(content, str):
        diagnostic['responseChars'] = len(content)
        diagnostic['responseSha256'] = hashlib.sha256(content.encode('utf-8', errors='surrogatepass')).hexdigest()
    if isinstance(error, json.JSONDecodeError):
        # Error messages/keys/values can contain credentials. Coordinates cannot.
        diagnostic.update(position=error.pos, line=error.lineno, column=error.colno)
    return {**response, '_protocol_error': instruction, '_protocol_diagnostic': diagnostic}


def normalize_native(response, *, used_ids=()):
    """Normalize objects without inventing call IDs or changing arguments."""
    if not isinstance(response, dict):
        return response
    raw_calls = response.get('tool_calls')
    if raw_calls is None:
        return response
    if not isinstance(raw_calls, list):
        return failure(response, 'invalid_native_envelope', 'Return a valid native tool_calls list.')
    calls, seen = [], set(used_ids)
    for call in raw_calls:
        if not isinstance(call, dict) or not isinstance(call.get('function'), dict):
            return failure(response, 'invalid_native_envelope', 'Return complete native function calls with IDs, names and arguments.')
        cid = call.get('id')
        fn = dict(call['function'])
        if (not isinstance(cid, str) or not cid or call.get('type') != 'function'
                or not isinstance(fn.get('name'), str) or not fn['name']):
            return failure(response, 'invalid_native_envelope', 'Return complete native function calls with IDs, names and arguments.')
        if cid in seen:
            return failure(response, 'duplicate_call_id', 'Use a fresh unique ID for each native call; do not repeat a completed call.')
        seen.add(cid)
        if isinstance(fn.get('arguments'), dict):
            try:
                fn['arguments'] = json.dumps(fn['arguments'], ensure_ascii=False, allow_nan=False)
                fn['arguments'].encode('utf-8')
            except (ValueError, UnicodeError, RecursionError):
                return failure(response, 'invalid_native_arguments', 'Use finite JSON values and valid Unicode in tool arguments.')
        if not isinstance(fn.get('arguments'), str):
            return failure(response, 'invalid_native_arguments', 'Return tool arguments as a JSON object encoded in a string.')
        # Invalid JSON strings remain ordinary failed tool results. They are not
        # replaced with {}, which could execute a mutating zero-argument tool.
        calls.append({**call, 'function': fn})
    return {**response, 'tool_calls': calls}


def record_failure(session, diagnostic, *, protocol, attempt, finish=None, turn_id=None):
    row = {**diagnostic, 'protocol': protocol, 'attempt': attempt,
           'step': session.get('steps', 0), 'turn_id': turn_id,
           'outcome': 'repairing'}
    if finish is not None:
        row['finishReason'] = finish
    history = session.setdefault('protocol_diagnostics', [])
    history.append(row)
    del history[:-24]
    return row


def public_diagnostics(raw):
    """Whitelist even journal metadata; never expose arbitrary stored fields."""
    if not isinstance(raw, list):
        return []
    rows = []
    for row in raw[-24:]:
        if (not isinstance(row, dict) or not isinstance(row.get('code'), str) or row.get('code') not in DIAGNOSTIC_CODES
                or row.get('protocol') not in ('json', 'native')
                or row.get('outcome') not in ('repairing', 'recovered', 'exhausted')):
            continue
        safe = {key: row[key] for key in ('code', 'protocol', 'outcome')}
        for key in ('step', 'attempt', 'responseChars', 'position', 'line', 'column'):
            if type(row.get(key)) is int and 0 <= row[key] <= 2_000_000:
                safe[key] = row[key]
        if isinstance(row.get('responseSha256'), str) and re.fullmatch('[a-f0-9]{64}', row['responseSha256']):
            safe['responseSha256'] = row['responseSha256']
        from .response_metadata import FINISH_REASONS
        if isinstance(row.get('finishReason'), str) and row['finishReason'] in FINISH_REASONS:
            safe['finishReason'] = row['finishReason']
        rows.append(safe)
    return rows


class NativeCallAssembler:
    """Assemble SSE fragments only; execution awaits the complete response."""
    def __init__(self):
        self.calls = {}
        self.ids = {}
        self.object_arguments = set()

    def add(self, fragments):
        if not isinstance(fragments, list):
            raise ValueError('tool call fragments must be a list')
        for call in fragments:
            if not isinstance(call, dict):
                raise ValueError('invalid tool call fragment')
            index = call.get('index', 0)
            if type(index) is not int or not 0 <= index < 128:
                raise ValueError('invalid tool call index')
            target = self.calls.setdefault(index, {'id': '', 'type': 'function',
                                                  'function': {'name': '', 'arguments': ''}})
            cid = call.get('id')
            if cid is not None:
                if (not isinstance(cid, str) or not cid
                        or target['id'] and target['id'] != cid
                        or cid in self.ids and self.ids[cid] != index):
                    raise ValueError('conflicting tool call identity')
                target['id'] = cid
                self.ids[cid] = index
            if call.get('type', 'function') != 'function':
                raise ValueError('invalid tool call type')
            fn = call.get('function', {})
            if not isinstance(fn, dict):
                raise ValueError('invalid tool function fragment')
            for field in ('name', 'arguments'):
                value = fn.get(field)
                if value is None:
                    continue
                if field == 'arguments' and isinstance(value, dict):
                    if target['function'][field]:
                        raise ValueError('mixed argument object and fragments')
                    value = json.dumps(value, ensure_ascii=False, allow_nan=False)
                    value.encode('utf-8')
                    self.object_arguments.add(index)
                elif field == 'arguments' and value and index in self.object_arguments:
                    raise ValueError('mixed argument object and fragments')
                if not isinstance(value, str):
                    raise ValueError('tool function fragment must be text')
                target['function'][field] += value

    def finish(self):
        return [self.calls[index] for index in sorted(self.calls)]
