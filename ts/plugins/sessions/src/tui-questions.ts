import type { Key } from 'node:readline';
import type { TuiDialog, TuiDialogView, TuiQuestion } from './tui-types.ts';
import { cellWidth } from './tui-text.ts';

interface AnswerState {
  selected: Set<number>;
  custom: string;
  skipped: boolean;
}

export function questionDialog(questions: readonly TuiQuestion[]): TuiDialog<string | null> {
  const answers: AnswerState[] = questions.map(() => ({ selected: new Set<number>(), custom: '', skipped: false }));
  let current = 0;
  let option = 0;
  let review = false;
  let editingOther = false;
  let otherBuffer = '';
  let result: string | null | undefined;

  const question = (): TuiQuestion | undefined => questions[current];
  const state = (): AnswerState | undefined => answers[current];
  const options = (q: TuiQuestion | undefined) => q?.options ?? [];
  const choicesCount = (q: TuiQuestion | undefined) => options(q).length + 1;

  function answerText(index: number): string {
    const q = questions[index]!;
    const value = answers[index]!;
    const labels = [...value.selected].sort((a, b) => a - b).map((picked) => options(q)[picked]?.label).filter((label): label is string => Boolean(label));
    return [labels.join(', '), value.custom.trim()].filter(Boolean).join('；');
  }

  function formattedAnswers(): string {
    return questions.flatMap((q, index) => {
      const text = answerText(index);
      return text ? [`[${q.id}] ${q.header}: ${text}`] : [];
    }).join('\n');
  }

  function next(): void {
    if (current >= questions.length - 1) review = true;
    else { current += 1; option = 0; }
  }

  function view(language: 'zh' | 'en'): TuiDialogView {
    const zh = language === 'zh';
    const title = zh ? '补充问题' : 'Clarifying questions';
    const lines: string[] = [];
    lines.push(questions.map((q, index) => `${index === current && !review ? '›' : ' '}${index + 1}. ${q.header}`).join('  '));
    if (review) {
      lines.push(zh ? '检查答案' : 'Review answers');
      questions.forEach((q, index) => {
        const text = answerText(index);
        lines.push(text ? `[${q.id}] ${q.header}: ${text}` : `[${q.id}] ${q.header}: ${zh ? '已跳过' : 'Skipped'}`);
      });
      return { title, lines, help: zh ? 'Enter 提交 · Tab 返回首题 · PgUp 返回末题 · Esc 取消' : 'Enter submit · Tab first question · PgUp last question · Esc cancel' };
    }
    const q = question();
    const value = state();
    if (!q || !value) return { title, lines, help: zh ? 'Esc 取消' : 'Esc cancel' };
    lines.push(q.question);
    if (editingOther) {
      lines.push(zh ? '自定义答案:' : 'Custom answer:');
      lines.push(`› ${otherBuffer}`);
      return { title, lines, cursor: { row: lines.length - 1, column: cellWidth('› ' + otherBuffer) }, help: zh ? 'Enter 保存 · Esc 返回 · Backspace 删除 · Ctrl+U 清空' : 'Enter save · Esc back · Backspace delete · Ctrl+U clear' };
    }
    options(q).forEach((item, index) => {
      const checked = value.selected.has(index);
      const marker = q.multiSelect ? (checked ? '[x]' : '[ ]') : (checked ? '(•)' : '( )');
      lines.push(`${index === option ? '›' : ' '} ${marker} ${item.label}${item.description ? ` — ${item.description}` : ''}`);
    });
    const otherIndex = options(q).length;
    const otherMarker = q.multiSelect ? (value.custom ? '[x]' : '[ ]') : (value.custom ? '(•)' : '( )');
    lines.push(`${option === otherIndex ? '›' : ' '} ${otherMarker} ${zh ? '其他' : 'Other'}${value.custom ? ` — ${value.custom}` : ''}`);
    return { title, lines, selected: option + 2, help: zh ? '↑/↓ 或 j/k 移动 · 数字选择 · Space 多选 · o 自定义 · s 跳过 · Enter 确认 · Esc 取消' : '↑/↓ or j/k move · digits select · Space multi-select · o custom · s skip · Enter confirm · Esc cancel' };
  }

  return {
    view,
    key(text: string | undefined, key: Key) {
      if (result !== undefined) return { done: true, value: result };
      const q = question();
      const value = state();
      if (review) {
        if (key.name === 'escape') { result = null; return { done: true, value: result }; }
        if (key.name === 'return') { result = formattedAnswers(); return { done: true, value: result }; }
        if (key.name === 'tab') { review = false; current = 0; option = 0; }
        if (key.name === 'pageup') { review = false; current = Math.max(0, questions.length - 1); option = 0; }
        return { done: false };
      }
      if (!q || !value) {
        if (key.name === 'return') { result = ''; return { done: true, value: result }; }
        if (key.name === 'escape') { result = null; return { done: true, value: result }; }
        return { done: false };
      }
      if (editingOther) {
        if (key.name === 'escape') { editingOther = false; otherBuffer = ''; return { done: false }; }
        if (key.name === 'return') {
          const custom = otherBuffer.trim();
          if (custom) { value.custom = custom; value.skipped = false; if (!q.multiSelect) value.selected.clear(); }
          editingOther = false; otherBuffer = '';
          return { done: false };
        }
        if (key.ctrl && (key.name === 'u' || text === 'u')) { otherBuffer = ''; return { done: false }; }
        if (key.name === 'backspace') {
          const parts = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(otherBuffer), (part) => part.segment);
          otherBuffer = parts.slice(0, -1).join('');
          return { done: false };
        }
        if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/u.test(text)) otherBuffer += text;
        return { done: false };
      }
      if (key.name === 'escape') { result = null; return { done: true, value: result }; }
      if (key.name === 'up' || key.name === 'k' || text?.toLowerCase() === 'k') {
        option = Math.max(0, option - 1); return { done: false };
      }
      if (key.name === 'down' || key.name === 'j' || text?.toLowerCase() === 'j') {
        option = Math.min(choicesCount(q) - 1, option + 1); return { done: false };
      }
      if (key.name === 'o' || text?.toLowerCase() === 'o') { editingOther = true; otherBuffer = value.custom; return { done: false }; }
      if (key.name === 's' || text?.toLowerCase() === 's') {
        value.selected.clear(); value.custom = ''; value.skipped = true; next(); return { done: false };
      }
      const digitText = text ?? key.name ?? '';
      if (/^[1-9]$/u.test(digitText)) {
        const picked = Number(digitText) - 1;
        if (picked < options(q).length) {
          if (q.multiSelect) {
            if (value.selected.has(picked)) value.selected.delete(picked); else value.selected.add(picked);
          } else { value.selected.clear(); value.selected.add(picked); value.custom = ''; value.skipped = false; }
          option = picked;
        } else if (picked === options(q).length) {
          option = picked; editingOther = true; otherBuffer = value.custom;
        }
        return { done: false };
      }
      if (q.multiSelect && (key.name === 'space' || text === ' ')) {
        if (option < options(q).length) {
          if (value.selected.has(option)) value.selected.delete(option); else value.selected.add(option);
          value.skipped = false;
        } else { editingOther = true; otherBuffer = value.custom; }
        return { done: false };
      }
      if (key.name === 'return') {
        const otherIndex = options(q).length;
        if (option === otherIndex && !value.custom) { editingOther = true; otherBuffer = ''; return { done: false }; }
        if (q.multiSelect) {
          if (value.selected.size === 0 && !value.custom) return { done: false };
        } else if (value.selected.size === 0 && !value.custom && option < otherIndex) {
          value.selected.add(option);
        }
        if (value.selected.size === 0 && !value.custom) return { done: false };
        value.skipped = false;
        next();
      }
      return { done: false };
    },
    cancel() { return null; },
  };
}
