/**
 * Pure helpers for the browser pane: what an action means in words, what a
 * worker error means for the person, how a typed address becomes a URL, and
 * the snapshot text as rows. No IO; nothing here approves or runs an action.
 */
import { t as tr, tf } from '../../i18n';
import type { BrowserAction } from './browserSessionRegistry';

/** Actions that change the page; a fresh screenshot is worth asking for after them. */
export const PAGE_CHANGING = new Set<BrowserAction['action']>(['navigate', 'refresh', 'click', 'fill']);

/** A typed address as an HTTPS URL, or an error key. Bare hosts get https://. */
export function normalizeAddress(raw: string): { url: string } | { error: string } {
  const value = raw.trim();
  if (!value) return { error: tr('请输入网址') };
  if (/^http:\/\//i.test(value)) return { error: tr('只能打开 HTTPS 网址') };
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !url.hostname.includes('.')) return { error: tr('只能打开公开的 HTTPS 网址') };
    return { url: url.toString() };
  } catch { return { error: tr('网址格式不正确') }; }
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

const clip = (value: string, max = 64) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** `role「name」` for an `aria-ref=` selector found in the latest snapshot, for words instead of a ref. */
export function describeTarget(tree: string | undefined, selector: string | undefined): string | undefined {
  const ref = /^aria-ref=((?:f\d+)?e\d+)$/.exec(selector ?? '')?.[1];
  if (!tree || !ref) return undefined;
  const row = parseSnapshot(tree).rows.find(item => item.ref === ref);
  return row ? `${row.role}「${clip(row.name || ref, 48)}」` : undefined;
}

/** One line saying what the person is approving; `target` names a picked element. */
export function actionSummary(action: BrowserAction, target?: string): string {
  if (target && action.action === 'click') return tf('点击 {0}', [target]);
  if (target && action.action === 'fill') return tf('在 {0} 中填写 {1} 个字符', [target, [...(action.text ?? '')].length]);
  switch (action.action) {
    case 'navigate': return tf('打开 {0}', [clip(action.url ?? '', 80)]);
    case 'refresh': return tr('重新加载当前页面');
    case 'inspect': return tr('读取页面文字和链接');
    case 'snapshot': return tr('读取页面元素结构');
    case 'screenshot': return tr('截取当前页面');
    case 'click': return tf('点击 {0}', [clip(action.selector ?? '')]);
    case 'fill': return tf('在 {0} 中填写 {1} 个字符', [clip(action.selector ?? '', 40), [...(action.text ?? '')].length]);
  }
}

/** Whether the action can send something to the site, as the approval bar says it. */
export const sendsToSite = (action: BrowserAction): boolean => PAGE_CHANGING.has(action.action);

/** Short verb for progress and the activity log. */
export function actionVerb(action: BrowserAction['action']): string {
  return ({ navigate: tr('打开页面'), refresh: tr('重新加载'), inspect: tr('读取文字'), snapshot: tr('读取元素'),
    screenshot: tr('截图'), click: tr('点击'), fill: tr('填写') } as const)[action];
}

/** The worker and server speak English codes; say what happened and what to do. */
export function friendlyError(message: string, action?: BrowserAction['action']): string {
  const text = message.trim();
  if (/fakeip DNS answer blocked/i.test(text)) return tr('系统 DNS 返回了代理的 FakeIP 地址（198.18.x.x），浏览器按安全规则拒绝打开。可以把代理的 DNS 模式改为返回真实地址后再试。');
  if (/page load timed out/i.test(text)) return tr('页面加载超时，请稍后重试或换一个网址。');
  if (/public HTTPS URL required/i.test(text)) return tr('只能打开公开的 HTTPS 网址，不支持 http、本机或内网地址。');
  if (/navigate to a public HTTPS page first|page unavailable/i.test(text)) return tr('请先在地址栏打开一个 HTTPS 网页。');
  if (/worker unavailable/i.test(text)) return tr('浏览器进程不可用。请关闭此标签页后新建一个。');
  if (/approval expired|action changed/i.test(text)) return tr('批准已过期或操作已变化，请重新发起。');
  if (/plan mode/i.test(text)) return tr('计划模式下不能操作浏览器。');
  if (/at most eight/i.test(text)) return tr('最多同时打开 8 个标签页。');
  if (/workspace root not permitted|workspace binding changed|session binding changed|invalid session/i.test(text)) return tr('当前任务的工作区不允许使用浏览器，请换一个任务后重试。');
  if (/remote browser/i.test(text)) return tr('远程工作区的浏览器不可用。');
  if (/screenshot exceeds|Invalid screenshot|invalid screenshot/i.test(text)) return tr('截图无效或超过大小上限。');
  if (/Cancellation not confirmed|already submitted|cannot undo/i.test(text)) return tr('未能确认取消：操作可能已经提交，取消无法撤回它的效果。');
  if (/browser action failed/i.test(text)) {
    return action === 'click' || action === 'fill'
      ? tr('没有找到可操作的元素，页面可能已变化。请重新读取元素后再试。')
      : tr('浏览器操作失败，页面可能无法访问或加载超时。');
  }
  return text || tr('浏览器操作失败');
}

export interface SnapshotRow { depth: number; role: string; name: string; ref?: string; flags: string[] }

/** The bounded snapshot tree (`- role "name" [ref=e1] [disabled]`) as rows; the truncation marker becomes `note`. */
export function parseSnapshot(tree: string): { rows: SnapshotRow[]; note?: string } {
  const rows: SnapshotRow[] = [];
  let note: string | undefined;
  for (const line of tree.split('\n')) {
    if (/^\[truncated:/.test(line)) { note = line.slice(1, -1); continue; }
    const match = /^( *)- ([A-Za-z][A-Za-z0-9_-]*)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]+\])*)$/.exec(line);
    if (!match) continue;
    let name = '';
    if (match[3]) { try { name = JSON.parse(match[3]) as string; } catch { name = match[3].slice(1, -1); } }
    const flags = [...(match[4] ?? '').matchAll(/\[([^\]]+)\]/g)].map(flag => flag[1]!);
    const ref = flags.find(flag => flag.startsWith('ref='))?.slice(4);
    rows.push({ depth: Math.floor((match[1] ?? '').length / 2), role: match[2]!, name, ...(ref ? { ref } : {}), flags: flags.filter(flag => !flag.startsWith('ref=')) });
  }
  return { rows, ...(note ? { note } : {}) };
}

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
