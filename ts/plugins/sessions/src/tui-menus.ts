import type { TuiChoice, TuiLine, TuiMenu, TuiMenuKind, TuiMenuQuery } from './tui-types.ts';
import { cellWidth, clipText } from './tui-text.ts';

/** Resolve the completion context immediately before the editor cursor. */
export function menuQuery(draft: string, cursor: number): TuiMenuQuery | undefined {
  const end = Math.max(0, Math.min(draft.length, Math.trunc(cursor)));
  const prefix = draft.slice(0, end);
  const mention = activeFileMention(prefix);
  if (mention) return { kind: 'file', query: mention.token, from: mention.from, to: end };

  const model = commandQuery(prefix, '/model');
  if (model !== undefined && model.trim() !== 'list') {
    return { kind: 'model', query: model, from: 0, to: end };
  }
  const effort = commandQuery(prefix, '/effort', '/variant');
  if (effort !== undefined) return { kind: 'effort', query: effort, from: 0, to: end };
  const mode = commandQuery(prefix, '/mode');
  if (mode !== undefined) return { kind: 'mode', query: mode, from: 0, to: end };

  if (prefix.startsWith('/') && !/\s/u.test(prefix)) {
    return { kind: 'slash', query: prefix.slice(1), from: 0, to: end };
  }
  return undefined;
}

function commandQuery(prefix: string, ...commands: string[]): string | undefined {
  for (const command of commands) {
    if (prefix === command) return '';
    if (prefix.startsWith(`${command} `)) return prefix.slice(command.length + 1);
  }
  return undefined;
}

function activeFileMention(prefix: string): { from: number; token: string } | undefined {
  const from = prefix.lastIndexOf('@');
  if (from < 0 || (from > 0 && !/\s/u.test(prefix[from - 1]!))) return undefined;
  const token = prefix.slice(from + 1);
  if (/\s/u.test(token)) return undefined;
  return { from, token };
}

export function filterChoices(choices: readonly TuiChoice[], query: string): readonly TuiChoice[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return choices;
  return choices.filter((choice) =>
    [choice.id, choice.label, choice.value, choice.description, ...(choice.keywords ?? [])]
      .some((value) => value?.toLowerCase().includes(normalized)),
  );
}

export function completeChoice(
  draft: string,
  menu: TuiMenu,
  item: TuiChoice,
): { text: string; cursor: number; attach?: string; submit: boolean } {
  if (menu.kind === 'slash') {
    const text = `${item.value} `;
    return { text, cursor: text.length, submit: false };
  }
  if (menu.kind === 'model' || menu.kind === 'effort' || menu.kind === 'mode') {
    return { text: item.value, cursor: item.value.length, submit: false };
  }
  if (menu.kind === 'file') {
    const replacement = `@${item.value}${item.directory ? '' : ' '}`;
    const text = draft.slice(0, menu.from) + replacement + draft.slice(menu.to);
    return {
      text,
      cursor: menu.from + replacement.length,
      ...(item.directory ? {} : { attach: item.value }),
      submit: false,
    };
  }
  return { text: item.value, cursor: item.value.length, submit: true };
}

export function menuLines(menu: TuiMenu, width: number, height: number, language: string): TuiLine[] {
  const columns = Math.max(0, Math.floor(width));
  const rows = Math.max(0, Math.floor(height));
  if (rows === 0) return [];
  const fit = (text: string): string => cellWidth(text) <= columns ? text : clipText(text, columns);
  const lines: TuiLine[] = [{ text: fit(menu.title), tone: 'accent' }];
  const maxItems = Math.min(8, Math.max(0, rows - 2));
  const start = Math.max(0, Math.min(menu.selected - maxItems + 1, menu.items.length - maxItems));
  const visible = menu.items.slice(start, start + maxItems);
  for (let offset = 0; offset < visible.length && lines.length < rows - 1; offset += 1) {
    const item = visible[offset]!;
    const selected = start + offset === menu.selected;
    const marker = selected ? '❯ ' : '  ';
    const disabled = item.disabledReason ? ` (${item.disabledReason})` : '';
    lines.push({ text: fit(marker + item.label + disabled), tone: selected ? 'accent' : 'dim', action: 'menu:' + (start + offset) });
  }

  const current = menu.items[menu.selected];
  const detail = current?.disabledReason ?? current?.description;
  const hints: Record<TuiMenuKind, { en: string; zh: string }> = {
    slash: { en: 'Tab complete · Esc close', zh: 'Tab 补全 · Esc 关闭' },
    model: { en: 'Tab complete · Esc close', zh: 'Tab 补全 · Esc 关闭' },
    effort: { en: 'Tab complete · Esc close', zh: 'Tab 补全 · Esc 关闭' },
    mode: { en: 'Tab complete · Esc close', zh: 'Tab 补全 · Esc 关闭' },
    file: { en: 'Tab attach · Esc close', zh: 'Tab 附加 · Esc 关闭' },
    session: { en: 'Enter select · Esc close', zh: 'Enter 选择 · Esc 关闭' },
    child: { en: 'Enter select · Esc close', zh: 'Enter 选择 · Esc 关闭' },
    action: { en: 'Enter select · Esc close', zh: 'Enter 选择 · Esc 关闭' },
  };
  if (detail && lines.length < rows - 1) lines.push({ text: fit(detail), tone: current?.disabledReason ? 'warning' : 'dim' });
  if (lines.length < rows) lines.push({ text: fit(hints[menu.kind][language === 'zh' ? 'zh' : 'en']), tone: 'dim' });
  return lines.slice(0, rows);
}
