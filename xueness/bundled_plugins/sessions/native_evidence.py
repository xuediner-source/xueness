"""A bounded final citation line keeps native answers out of JSON strings."""
import re

_LINE = re.compile(r'^(?:Evidence|证据)[：:][ \t]*(E[1-9][0-9]*(?:[ \t]*[,，][ \t]*E[1-9][0-9]*)*)[ \t]*$', re.IGNORECASE)


def extract(content):
    lines = content.rstrip().splitlines()
    if len(lines) < 2:
        return None
    match = _LINE.fullmatch(lines[-1])
    if match is None or len(lines[-1]) > 512:
        return None
    body = '\n'.join(lines[:-1]).rstrip()
    # A quoted/code/example footer is not an executable completion contract.
    if not body or body.count('```') % 2 or body.count('~~~') % 2 or any(_LINE.fullmatch(line) for line in lines[:-1]):
        return None
    refs = [ref.upper() for ref in re.split(r'[ \t]*[,，][ \t]*', match.group(1))]
    if len(refs) > 24 or len(set(refs)) != len(refs):
        return None
    return body, [{'evidence_id': ref, 'observation': body[:2000]} for ref in refs]
