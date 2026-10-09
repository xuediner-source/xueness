"""Validation for implemented editor preferences and keyboard commands."""
DEFAULT_BINDINGS = {
    'new-session': 'Mod+N',
    'command-palette': 'Mod+K',
    'open-settings': 'Mod+,',
    'toggle-sidebar': 'Mod+B',
    'refresh-session': 'Alt+Shift+R',
}
COMMANDS = tuple(DEFAULT_BINDINGS)
TASK_AUTO_ARCHIVE_DAY_OPTIONS=(3,7,14,30)

_MODIFIER_ALIASES = {
    'mod': 'mod', 'ctrl': 'ctrl', 'control': 'ctrl',
    'meta': 'meta', 'command': 'meta', 'alt': 'alt', 'option': 'alt', 'shift': 'shift',
}
_MODIFIER_ORDER = ('mod', 'ctrl', 'meta', 'alt', 'shift')
_SINGLE_CHAR_KEYS = set('abcdefghijklmnopqrstuvwxyz0123456789.,/\\-=;[]`')
_NAMED_KEYS = {'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'delete'}
_RESERVED_SHORTCUTS = {
    ('alt', 'f4'),
    ('ctrl', 'alt', 'delete'), ('mod', 'alt', 'delete'),
    ('f5',), ('f12',),
    ('mod', 'j'), ('ctrl', 'j'), ('meta', 'j'),
    ('mod', 'l'), ('ctrl', 'l'), ('meta', 'l'),
    ('mod', 'o'), ('ctrl', 'o'), ('meta', 'o'),
    ('mod', 'p'), ('ctrl', 'p'), ('meta', 'p'),
    ('mod', 'q'), ('ctrl', 'q'), ('meta', 'q'),
    ('mod', 'r'), ('ctrl', 'r'), ('meta', 'r'),
    ('mod', 's'), ('ctrl', 's'), ('meta', 's'),
    ('mod', 't'), ('ctrl', 't'), ('meta', 't'),
    ('mod', 'w'), ('ctrl', 'w'), ('meta', 'w'),
    ('mod', 'shift', 'i'), ('ctrl', 'shift', 'i'), ('meta', 'shift', 'i'),
    ('mod', 'shift', 'j'), ('ctrl', 'shift', 'j'), ('meta', 'shift', 'j'),
    ('mod', 'shift', 't'), ('ctrl', 'shift', 't'), ('meta', 'shift', 't'),
}

def _normalize_shortcut(value):
    """Validate one recorded chord and return its platform-neutral form."""
    if not isinstance(value, str) or len(value) > 64:
        return None
    if value == '':
        return ''
    parts = [part.strip().lower() for part in value.split('+')]
    if len(parts) < 2 or any(not part for part in parts):
        return None
    raw_key = parts[-1]
    modifiers = [_MODIFIER_ALIASES.get(part) for part in parts[:-1]]
    if any(modifier is None for modifier in modifiers):
        return None
    if len(set(modifiers)) != len(modifiers):
        return None
    if not (raw_key in _SINGLE_CHAR_KEYS or raw_key in _NAMED_KEYS
            or raw_key in {f'f{number}' for number in range(1, 13)}):
        return None
    ordered = [modifier for modifier in _MODIFIER_ORDER if modifier in modifiers]
    return '+'.join([*ordered, raw_key])

def _is_reserved_shortcut(normalized):
    if not normalized:
        return False
    parts = normalized.split('+')
    direct = tuple(parts)
    if direct in _RESERVED_SHORTCUTS:
        return True
    # Mod means Command on macOS and Control elsewhere. Check both so saved
    # settings remain safe when moved between hosts.
    for platform_modifier in ('ctrl', 'meta'):
        mapped = tuple(platform_modifier if part == 'mod' else part for part in parts)
        if mapped in _RESERVED_SHORTCUTS:
            return True
    return False

def _platform_shortcut(normalized, platform_modifier):
    parts = normalized.split('+')
    return '+'.join(sorted(platform_modifier if part == 'mod' else part for part in parts[:-1]) + [parts[-1]])

def validate(section,values):
    if section=='general':
        if 'defaultShell' in values:
            from ..terminal.shells import SHELL_PATHS
            # Installed shells can disappear after a preference was saved.
            # Preserve a known profile while saving unrelated preferences;
            # opening a terminal separately verifies it is still executable.
            if not isinstance(values['defaultShell'], str) or values['defaultShell'] not in SHELL_PATHS:
                raise ValueError('defaultShell must be a supported shell profile')
        if 'terminalFontFamily' in values and values['terminalFontFamily'] not in ('system', 'Menlo', 'SFMono-Regular', 'monospace'):
            raise ValueError('unsupported terminal font family')
        if 'language' in values and values['language'] not in ('zh', 'en'):
            raise ValueError('language must be zh or en')
        for key in ('autoScroll', 'showTodos', 'collapseTools',
                    'toolGroupingExploreEnabled', 'toolGroupingTerminalEnabled',
                    'toolGroupingChangesEnabled', 'taskAutoArchiveEnabled',
                    'messageStreamShowReasoning', 'memoryEnabled',
                    'sessionsEventsCursorEnabled', 'sessionsEventResumeEnabled',
                    'sessionsCancelReceiptEnabled', 'sessionsCancelPropagateEnabled',
                    'remoteFrameReplayEnabled', 'desktopHostCapabilityEnabled',
                    'sessionsAnswerQuestionEnabled', 'toolsCallBudgetEnabled',
                    'toolsDryRunEnabled'):
            if key in values and type(values[key]) is not bool:
                raise ValueError(f'{key} must be boolean')
        if 'toolsCallBudgetLimit' in values and (type(values['toolsCallBudgetLimit']) is not int or not 1 <= values['toolsCallBudgetLimit'] <= 10000):
            raise ValueError('toolsCallBudgetLimit must be an integer from 1 to 10000')
        if ('taskAutoArchiveOlderThanDays' in values
                and (type(values['taskAutoArchiveOlderThanDays']) is not int
                     or values['taskAutoArchiveOlderThanDays'] not in TASK_AUTO_ARCHIVE_DAY_OPTIONS)):
            raise ValueError('taskAutoArchiveOlderThanDays must be 3, 7, 14 or 30')
    if section=='browser' and 'browserControlEnabled' in values and type(values['browserControlEnabled']) is not bool:
        raise ValueError('browserControlEnabled must be boolean')
    if section=='agent' and 'subagentCancelOneEnabled' in values and type(values['subagentCancelOneEnabled']) is not bool:
        raise ValueError('subagentCancelOneEnabled must be boolean')
    if section=='appearance':
        if 'theme' in values and values['theme'] not in ('system','light','dark'): raise ValueError('theme must be system, light or dark')
        if 'colorPalette' in values and values['colorPalette'] not in ('xueness','claude'): raise ValueError('colorPalette must be xueness or claude')
        if 'fontSize' in values and (type(values['fontSize']) is not int or not 12<=values['fontSize']<=24): raise ValueError('fontSize must be 12..24')
        if 'terminalFontSize' in values and (type(values['terminalFontSize']) is not int or not 10<=values['terminalFontSize']<=24): raise ValueError('terminalFontSize must be 10..24')
        if 'tabSize' in values and values['tabSize'] not in (2,4,8): raise ValueError('tabSize must be 2, 4 or 8')
        if 'wordWrap' in values and type(values['wordWrap']) is not bool: raise ValueError('wordWrap must be boolean')
    if section=='shortcuts':
        if 'sendShortcut' in values and values['sendShortcut'] not in ('enter', 'mod-enter'):
            raise ValueError('sendShortcut must be enter or mod-enter')
        if 'bindings' in values:
            bindings=values['bindings']
            if not isinstance(bindings,dict) or any(k not in COMMANDS for k in bindings): raise ValueError('unknown keyboard command')
            effective={**DEFAULT_BINDINGS,**bindings}
            seen={'mac':set(),'other':set()}
            for command,combo in effective.items():
                normalized=_normalize_shortcut(combo)
                if normalized is None: raise ValueError('invalid keyboard binding')
                if not normalized: continue  # explicit empty string clears the default binding
                if _is_reserved_shortcut(normalized): raise ValueError('keyboard binding is reserved: '+combo)
                for platform,modifier in (('mac','meta'),('other','ctrl')):
                    platform_normalized=_platform_shortcut(normalized,modifier)
                    if platform_normalized in seen[platform]: raise ValueError('keyboard binding conflict: '+combo)
                    seen[platform].add(platform_normalized)
    return values
