"""Structured operator questions, independent of appearance and permissions."""
from __future__ import annotations

import json
import re
from ... import plugin_runtime

_ID = re.compile(r'[a-zA-Z][a-zA-Z0-9_-]{0,63}\Z')
QUESTION_SCHEMA = {
    'type': 'array', 'minItems': 1, 'maxItems': 3,
    'description': 'Optional question cards. Never include an Other option: the UI always allows a custom answer. No choice is preselected.',
    'items': {'type': 'object', 'additionalProperties': False,
              'properties': {
                  'id': {'type': 'string', 'description': 'Unique stable identifier'},
                  'header': {'type': 'string', 'maxLength': 12},
                  'question': {'type': 'string', 'maxLength': 500},
                  'multiSelect': {'type': 'boolean'},
                  'options': {'type': 'array', 'minItems': 2, 'maxItems': 3,
                              'items': {'type': 'object', 'additionalProperties': False,
                                        'properties': {'label': {'type': 'string', 'maxLength': 80},
                                                       'description': {'type': 'string', 'maxLength': 300}},
                                        'required': ['label', 'description']}},
              }, 'required': ['id', 'header', 'question']},
}


def available(state_dir):
    return (state_dir is not None and plugin_runtime.is_enabled(state_dir, 'sessions')
            and plugin_runtime.is_enabled(state_dir, 'planning'))


def augment_schema(schema, state_dir):
    if not available(state_dir):
        return schema
    # Keep the legacy required `question` field. Simple/local providers need
    # no oneOf support, and older clients still receive a readable prompt.
    import copy
    schema = copy.deepcopy(schema)
    schema['function']['parameters']['properties']['questions'] = copy.deepcopy(QUESTION_SCHEMA)
    return schema


def _plain(value, limit, *, empty=False):
    if (not isinstance(value, str) or len(value) > limit
            or any(ord(char) < 32 and char not in '\n\t' for char in value)
            or any(0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise ValueError('invalid question text')
    text = value.strip()
    if not text and not empty:
        raise ValueError('question text must not be empty')
    return text


def normalize_questions(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 3:
        raise ValueError('questions must contain 1..3 items')
    rows, ids = [], set()
    for item in value:
        if not isinstance(item, dict) or set(item) - {'id', 'header', 'question', 'options', 'multiSelect'}:
            raise ValueError('invalid question fields')
        key = item.get('id')
        if not isinstance(key, str) or not _ID.fullmatch(key) or key in ids:
            raise ValueError('question ids must be unique identifiers')
        ids.add(key)
        row = {'id': key, 'header': _plain(item.get('header'), 12),
               'question': _plain(item.get('question'), 500), 'multiSelect': item.get('multiSelect', False)}
        if type(row['multiSelect']) is not bool:
            raise ValueError('multiSelect must be boolean')
        options = item.get('options', [])
        if not isinstance(options, list) or (options and not 2 <= len(options) <= 3):
            raise ValueError('options must contain 2..3 choices')
        labels, choices = set(), []
        for option in options:
            if not isinstance(option, dict) or set(option) != {'label', 'description'}:
                raise ValueError('each option needs a label and description')
            label = _plain(option['label'], 80)
            if label.casefold() in labels or label.casefold() in ('other', '其他'):
                raise ValueError('option labels must be unique; custom answers are provided by the UI')
            labels.add(label.casefold())
            choices.append({'label': label, 'description': _plain(option['description'], 300, empty=True)})
        row['options'] = choices
        rows.append(row)
    return rows


def pending_questions(session):
    if not isinstance(session, dict) or session.get('status') != 'awaiting_user':
        return []
    question = session.get('pending_question')
    results = session.get('results', {})
    if not isinstance(results, dict):
        return []
    messages = session.get('messages', [])
    if not isinstance(messages, list):
        return []
    for message in reversed(messages):
        calls = message.get('tool_calls', []) if isinstance(message, dict) else []
        if not isinstance(calls, list):
            continue
        for call in reversed(calls):
            if not isinstance(call, dict):
                continue
            result = results.get(call.get('id')) if isinstance(call.get('id'), str) else None
            function = call.get('function')
            if (isinstance(function, dict) and function.get('name') == 'ask_user'
                    and isinstance(result, dict) and result.get('awaiting_user') is True
                    and result.get('question') == question):
                try:
                    return normalize_questions(result['questions']) if 'questions' in result else []
                except ValueError:
                    return []
    return []


def normalize_answers(value):
    if not isinstance(value, dict) or not 1 <= len(value) <= 3:
        raise ValueError('answers must contain 1..3 question entries')
    answer = {}
    for key, item in value.items():
        if not isinstance(key, str) or not _ID.fullmatch(key) or not isinstance(item, dict) or set(item) - {'selected', 'text'}:
            raise ValueError('invalid answer fields')
        selected = item.get('selected', [])
        if not isinstance(selected, list) or len(selected) > 3:
            raise ValueError('invalid selected choices')
        selected = [_plain(label, 80) for label in selected]
        if len(set(selected)) != len(selected):
            raise ValueError('duplicate selected choices')
        text = _plain(item.get('text', ''), 1000, empty=True)
        if not selected and not text:
            raise ValueError('each question requires an explicit answer')
        answer[key] = {'selected': sorted(selected), 'text': text}
    return answer


def answer_digest_source(answers):
    return 'structured-question-answer\0' + json.dumps(answers, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def format_answers(questions, answers):
    if not questions or set(answers) != {row['id'] for row in questions}:
        raise ValueError('answer each question using its current id')
    lines = []
    for row in questions:
        answer = answers[row['id']]
        labels = [option['label'] for option in row['options']]
        selected = answer['selected']
        if any(choice not in labels for choice in selected) or (not row['multiSelect'] and len(selected) > 1):
            raise ValueError('selected choice does not match the current question')
        pieces = [choice for choice in labels if choice in selected]
        if answer['text']:
            pieces.append(answer['text'])
        lines.append(f"[{row['id']}] {row['header']}: " + '；'.join(pieces))
    return '\n'.join(lines)
