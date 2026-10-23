import type { Key } from 'node:readline';
import type { TuiDialog, TuiDialogView, TuiPermissionAnswer, TuiPermissionRequest } from './tui-types.ts';
import { cellWidth, graphemes } from './tui-text.ts';

type Choice = 'allowonce' | 'allowproject' | 'deny';

export function permissionDialog(request: TuiPermissionRequest): TuiDialog<TuiPermissionAnswer> {
  const canRemember = request.remember !== null && request.code === 'approval_required';
  const choices: Choice[] = canRemember ? ['allowonce', 'allowproject', 'deny'] : ['allowonce', 'deny'];
  let selected = 0;
  let editingFeedback = false;
  let feedback = '';
  let result: TuiPermissionAnswer | undefined;

  const deny = (): TuiPermissionAnswer => ({
    behavior: 'deny',
    message: `${request.kind} requires explicit approval`,
    reason: 'user_denied',
  });
  const allow = (choice: Choice): TuiPermissionAnswer => choice === 'allowproject'
    ? { behavior: 'allow', remember: request.remember!.exact, project: true }
    : { behavior: 'allow' };

  function commit(choice: Choice): void {
    result = choice === 'deny' ? deny() : allow(choice);
  }

  function view(language: 'zh' | 'en'): TuiDialogView {
    const zh = language === 'zh';
    const title = zh ? '权限确认' : 'Permission approval';
    const lines = [
      `${zh ? '工具' : 'Tool'}: ${request.tool}`,
      `${zh ? '类型' : 'Kind'}: ${request.kind}`,
      `${zh ? '对象' : 'Subject'}: ${request.subject}`,
      `${zh ? '说明' : 'Message'}: ${request.message}`,
    ];
    if (request.remember) {
      lines.push(zh ? '精确范围（仅供项目记忆）:' : 'Exact scope (project memory):');
      for (const scope of request.remember.exact) lines.push(`  ${scope}`);
      lines.push(zh ? '宽泛范围（不会自动授权）:' : 'Broader scopes (never granted automatically):');
      for (const scope of request.remember.broad) lines.push(`  ${scope}`);
    }
    if (editingFeedback) {
      lines.push(zh ? '拒绝原因（可留空）:' : 'Reason for denial (optional):');
      lines.push(`› ${feedback}`);
      return { title, lines, cursor: { row: lines.length - 1, column: cellWidth('› ' + feedback) }, help: zh ? 'Enter 确认拒绝 · Esc 返回选择 · Ctrl+U 清空' : 'Enter deny · Esc choices · Ctrl+U clear' };
    }
    const labels: Record<Choice, [string, string]> = {
      allowonce: ['Allow once', '仅本次允许'],
      allowproject: ['Always allow in this project', '在此项目中始终允许'],
      deny: ['Deny', '拒绝'],
    };
    const choiceStart = lines.length;
    choices.forEach((choice, index) => {
      const label = labels[choice][zh ? 1 : 0];
      lines.push(`${index === selected ? '›' : ' '} ${index + 1}. ${label}`);
    });
    return { title, lines, selected: choiceStart + selected, help: zh ? '↑/↓ 选择 · Enter 确认 · y/n 快捷确认 · r 填写拒绝原因 · Esc 拒绝' : '↑/↓ move · Enter confirm · y/n confirm · r denial feedback · Esc deny' };
  }

  return {
    view,
    key(text: string | undefined, key: Key) {
      if (result) return { done: true, value: result };
      if (editingFeedback) {
        if (key.name === 'escape') { editingFeedback = false; feedback = ''; return { done: false }; }
        if (key.name === 'return') { result = { ...deny(), ...(feedback.trim() ? { feedback: feedback.trim() } : {}) }; return { done: true, value: result }; }
        if (key.name === 'backspace') { feedback = graphemes(feedback).slice(0, -1).join(''); return { done: false }; }
        if (key.ctrl && (text === 'u' || key.name === 'u')) { feedback = ''; return { done: false }; }
        if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/u.test(text)) feedback += text;
        return { done: false };
      }
      if (key.name === 'up' || key.name === 'down') {
        selected = Math.max(0, Math.min(choices.length - 1, selected + (key.name === 'up' ? -1 : 1)));
        return { done: false };
      }
      if (key.name === 'escape') { commit('deny'); return { done: true, value: result! }; }
      if (key.name === 'return') { commit(choices[selected]!); return { done: true, value: result! }; }
      if (key.name === 'r' || text?.toLowerCase() === 'r') { editingFeedback = true; feedback = ''; return { done: false }; }
      if (key.name === 'y' || text?.toLowerCase() === 'y') { commit('allowonce'); return { done: true, value: result! }; }
      if (key.name === 'n' || text?.toLowerCase() === 'n') { commit('deny'); return { done: true, value: result! }; }
      if (/^[1-3]$/u.test(text ?? '')) {
        const index = Number(text) - 1;
        if (index < choices.length) selected = index;
      }
      return { done: false };
    },
    cancel() { return { behavior: 'cancel' }; },
  };
}
