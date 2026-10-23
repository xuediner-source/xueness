import type { TuiContext, TuiDocument, TuiLine, TuiSection, TuiSidebar, TuiSidebarState } from './tui-types.ts';
import { markdownLines } from './tui-markdown.ts';
import type { TuiThemeMode } from './tui-types.ts';

const sectionNames: Record<TuiSection, [string, string]> = {
  subagents: ['Subagents', '子代理'],
  mcp: ['MCP', 'MCP'],
  modifiedFiles: ['Modified Files', '已修改文件'],
  todos: ['Todos', '待办'],
  apis: ['APIs', 'API'],
};

type SidebarItem = { text: string; action?: string };
const row = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const items = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(row) : [];
const string = (...values: unknown[]): string => {
  const value = values.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return value ?? '';
};

export function createSidebarState(): TuiSidebarState {
  return { preference: 'auto', overlay: false, sections: { subagents: true, mcp: true, modifiedFiles: true, todos: true, apis: true } };
}

export function sidebarLayout(columns: number, state: TuiSidebarState): { visible: boolean; overlay: boolean; width: number } {
  if (columns > 120) return { visible: state.preference === 'auto', overlay: false, width: 42 };
  return { visible: state.overlay, overlay: state.overlay, width: 42 };
}

export function toggleSidebar(state: TuiSidebarState, columns: number): boolean {
  const layout = sidebarLayout(columns, state);
  if (columns > 120) state.preference = layout.visible ? 'hidden' : 'auto';
  else {
    state.overlay = !layout.visible;
    state.preference = state.overlay ? 'auto' : 'hidden';
  }
  return sidebarLayout(columns, state).visible;
}

export function toggleSidebarSection(state: TuiSidebarState, id: TuiSection): boolean {
  state.sections[id] = !state.sections[id];
  return state.sections[id];
}

export function sidebarLines(data: TuiSidebar, doc: TuiDocument, context: TuiContext, state: TuiSidebarState, width: number, language: 'zh' | 'en'): TuiLine[] {
  const mode: TuiThemeMode = context.theme === 'light' ? 'light' : 'dark';
  const zh = language === 'zh';
  const lines: TuiLine[] = [];
  const emit = (value: string, action?: string, tone?: TuiLine['tone']) => {
    for (const text of markdownLines(value, width, mode)) lines.push({ text, ...(action ? { action } : {}), ...(tone ? { tone } : {}) });
  };
  const section = (id: TuiSection, content: SidebarItem[]) => {
    emit(`${state.sections[id] ? '−' : '+'} ${sectionNames[id][zh ? 1 : 0]}`, `sidebar:${id}`, 'accent');
    if (state.sections[id]) for (const item of content) emit(`  ${item.text}`, item.action);
  };

  const product = context.version ? `Xueness · ${context.version}` : 'Xueness';
  emit(product, undefined, 'accent');
  if (context.model) emit(context.model);
  emit(zh ? '状态' : 'Status', undefined, 'accent');
  const status = string(data.status, doc.lastEvent);
  if (status) emit(status);
  const error = string(data.error, doc.error);
  if (error) emit(error, undefined, 'error');
  if (context.mode) emit(`${zh ? '模式' : 'Mode'}: ${context.mode}`);
  if (context.effort) emit(`${zh ? '思考' : 'Reasoning'}: ${context.effort}`);

  const subagents = items(data.subagents).map((item) => {
    const id = string(item.task?.id, item.taskId, item.id);
    return { text: `${string(item.status) || 'running'}  ${string(item.title, item.description, id)}`, action: id ? `child:${id}` : undefined };
  });
  section('subagents', subagents);

  const mcp = items(data.mcp).map((item) => {
    const state = row(item.status) ? string(item.status.status) : string(item.status);
    const name = string(item.name, item.id, 'MCP');
    const details = [state, string(item.transport), typeof item.toolCount === 'number' ? `${item.toolCount} tools` : ''].filter(Boolean).join(' · ');
    return { text: [name, details, string(item.error)].filter(Boolean).join('  ') };
  });
  section('mcp', mcp);

  const files = items(data.files).map((file) => {
    const path = string(file.path, file.file_path, file.filePath, file.name);
    const added = file.added ?? file.additions;
    const removed = file.removed ?? file.deletions;
    const counts = [typeof added === 'number' ? `+${added}` : '', typeof removed === 'number' ? `-${removed}` : ''].filter(Boolean).join(' ');
    return { text: `${path}${counts ? ` ${counts}` : ''}`, action: path ? `file:${path}` : undefined };
  });
  section('modifiedFiles', files);

  const todos = items(data.todos);
  const completed = todos.filter((todo) => todo.status === 'completed' || todo.completed === true).length;
  const todoLines: SidebarItem[] = [
    { text: `${zh ? '进度' : 'Progress'} ${completed}/${todos.length}` },
    ...todos.slice(0, 6).map((todo) => ({ text: `${todo.status === 'completed' || todo.completed === true ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]'} ${string(todo.content, todo.title, todo.text)}` })),
    ...(todos.length > 6 ? [{ text: `… ${todos.length - 6} ${zh ? '更多' : 'more'}` }] : []),
  ];
  section('todos', todoLines);

  if (context.developer) {
    const apis = items(data.apis).map((api) => ({ text: [api.requestStep ? `#${api.requestStep}` : '', string(api.method), string(api.url, api.name), string(api.status, api.phase), typeof api.requestSeconds === 'number' ? `${api.requestSeconds}s` : ''].filter(Boolean).join(' ') }));
    section('apis', apis);
  }

  const used = data.contextUsed ?? doc.contextUsed;
  const contextWindow = data.contextWindow ?? doc.contextWindow;
  const usage = { ...doc.usage, ...(row(data.usage) ? data.usage : {}) };
  const usageFields = Object.entries(usage).filter(([, value]) => typeof value === 'number' && Number.isFinite(value));
  if (typeof used === 'number' || typeof contextWindow === 'number' || usageFields.length) {
    emit(zh ? '上下文与用量' : 'Context & usage', undefined, 'accent');
    if (typeof contextWindow === 'number') emit(`${zh ? '窗口' : 'Window'}: ${contextWindow}`);
    if (typeof used === 'number') emit(`${zh ? '已用' : 'Used'}: ${used}${typeof contextWindow === 'number' && contextWindow > 0 ? ` (${Math.round(used / contextWindow * 100)}%)` : ''}`);
    for (const [key, value] of usageFields) {
      const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
      emit(`${label}: ${value}`);
    }
  }

  const root = string(context.root);
  const branch = string(context.branch, data.branch);
  if (root || branch) emit(root && branch ? `${root} · ${branch}` : root || branch);
  return lines;
}
