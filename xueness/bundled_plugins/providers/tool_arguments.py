"""Preflight the JSON-schema vocabulary used by advertised bundled tools.

Handlers and Gate remain authoritative. This preflight returns actionable input
errors before hooks/approvals/effects; it does not grant a capability or supply
missing/default values. Provider-specific unsupported keywords stay with the
tool's own validator rather than being represented as full JSON-schema support.
"""
import re


class ArgumentMismatch(ValueError):
    def __init__(self, reason, path):
        self.reason = reason
        self.path = path
        super().__init__('tool arguments do not match the advertised schema')


def validate_arguments(value, schema, path='arguments', depth=0):
    if depth > 32:
        raise ArgumentMismatch('nesting_limit', path)
    if not isinstance(schema, dict):
        return
    if isinstance(schema.get('anyOf'), list):
        for candidate in schema['anyOf']:
            try:
                validate_arguments(value, candidate, path, depth+1)
                break
            except ArgumentMismatch:
                pass
        else:
            raise ArgumentMismatch('type_or_constraint', path)
    expected = schema.get('type')
    kinds = expected if isinstance(expected, list) else [expected] if expected else []
    matches = {
        'object': isinstance(value, dict), 'array': isinstance(value, list),
        'string': isinstance(value, str), 'boolean': type(value) is bool,
        'integer': type(value) is int or type(value) is float and value.is_integer(),
        'number': type(value) in (int, float), 'null': value is None,
    }
    if kinds and not any(matches.get(kind, True) for kind in kinds):
        raise ArgumentMismatch('type', path)
    if 'enum' in schema and value not in schema['enum']:
        raise ArgumentMismatch('enum', path)
    if isinstance(value, dict):
        properties = schema.get('properties', {})
        for name in schema.get('required', []):
            if name not in value:
                raise ArgumentMismatch('required', _path(path, name))
        if schema.get('additionalProperties') is False and set(value) - set(properties):
            # Unknown model-generated keys can contain private data. Never echo.
            raise ArgumentMismatch('additional_parameter', path)
        for name, item in value.items():
            if name in properties:
                validate_arguments(item, properties[name], _path(path, name), depth+1)
    elif isinstance(value, list):
        if len(value) < schema.get('minItems', 0) or len(value) > schema.get('maxItems', float('inf')):
            raise ArgumentMismatch('array_length', path)
        if isinstance(schema.get('items'), dict):
            for item in value:
                validate_arguments(item, schema['items'], path+'[]', depth+1)
    elif isinstance(value, str):
        if len(value) < schema.get('minLength', 0) or len(value) > schema.get('maxLength', float('inf')):
            raise ArgumentMismatch('text_length', path)
        if isinstance(schema.get('pattern'), str) and (len(value) > 10000 or not re.search(schema['pattern'], value)):
            raise ArgumentMismatch('pattern', path)
    elif type(value) in (int, float):
        if value < schema.get('minimum', float('-inf')) or value > schema.get('maximum', float('inf')):
            raise ArgumentMismatch('number_range', path)


def _path(path, name):
    return path+'.'+name if isinstance(name, str) and re.fullmatch('[A-Za-z0-9_]{1,64}', name) else path


def preflight(value, name, schemas):
    schema = next(((s.get('function') or {}).get('parameters') for s in schemas
                   if (s.get('function') or {}).get('name') == name), None)
    try:
        validate_arguments(value, schema)
    except ArgumentMismatch as error:
        return {'ok': False, 'error': str(error), 'error_code': 'invalid_tool_arguments',
                'argument_issue': error.reason, 'argument_path': error.path}
    return None
