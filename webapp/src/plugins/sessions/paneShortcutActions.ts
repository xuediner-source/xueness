// sessions.scoped_commands: actions resolve only inside the focused, visible leaf.
import { useEffect, useRef, type RefObject } from 'react';
import { isImeComposingEvent, resolveHostPlatform } from '../../xuenessShortcutDisplay';
import { SHORTCUT_COMMANDS, composerOwnsShortcutEvent, hasGlobalShortcutConflict, isReservedShortcut, isTerminalTarget, matchesShortcut, resolveShortcutBinding, type ShortcutCommandDefinition, type ShortcutEventLike } from '../../xuenessShortcutCommands';
export const PANE_CONTROL_COMMANDS: readonly ShortcutCommandDefinition[] = [
  { id: 'find-in-task', label: '任务内查找', description: '查找当前聚焦窗格的对话。', scope: 'pane', defaultBinding: 'Alt+Shift+F' },
  { id: 'open-model-menu', label: '选择模型', description: '打开聚焦窗格的模型菜单。', scope: 'pane', defaultBinding: 'Alt+Shift+M' },
  { id: 'open-mode-menu', label: '模式与权限', description: '打开聚焦窗格的模式菜单；权限变更仍需明确选择。', scope: 'pane', defaultBinding: 'Alt+Shift+U' },
  { id: 'open-reasoning-menu', label: '思考强度', description: '打开聚焦窗格的思考强度菜单。', scope: 'pane', defaultBinding: 'Alt+Shift+T' },
  { id: 'open-workspace', label: '选择工作区', description: '打开聚焦窗格已有的工作区选择器。', scope: 'pane', defaultBinding: 'Alt+Shift+O' },
];
export function evaluatePaneControlKey(event: ShortcutEventLike, context: {
  enabled: boolean; blocked?: boolean; target?: unknown; bindings: Record<string, string>; platform?: string;
}): string | null {
  if (!context.enabled || context.blocked || event.defaultPrevented || event.repeat || isImeComposingEvent(event) || isTerminalTarget(context.target)) return null;
  if (hasGlobalShortcutConflict(event, 'command-palette', context.target, context.platform)
    || composerOwnsShortcutEvent(event, context.target, context.bindings, context.platform)) return null;
  // Global commands have first ownership when a user reuses a chord across scopes.
  if (SHORTCUT_COMMANDS.some(command => command.scope === 'global'
    && matchesShortcut(event, resolveShortcutBinding(command.id, context.bindings), context.platform)
    && !hasGlobalShortcutConflict(event, command.id, context.target, context.platform))) return null;
  return PANE_CONTROL_COMMANDS.find(command => {
    const binding = resolveShortcutBinding(command.id, context.bindings, command.defaultBinding);
    return binding && !isReservedShortcut(binding) && matchesShortcut(event, binding, context.platform);
  })?.id ?? null;
}
/** A real enabled button is the handler: no synthesized choices or permission bypass. */
export function paneControlTarget(root: HTMLElement | null, paneId: string, command: string): HTMLElement | null {
  if (!root || !PANE_CONTROL_COMMANDS.some(item => item.id === command)) return null;
  const pane = Array.from(root.querySelectorAll<HTMLElement>('[data-pane-focused]')).find(node => node.dataset.paneId === paneId && node.dataset.paneFocused === 'true' && !node.hidden);
  if (!pane) return null;
  const target = command === 'find-in-task'
    ? pane.querySelector<HTMLElement>('[data-zcode-find-ui] input') ?? pane.querySelector<HTMLElement>('[data-shortcut-action="find-in-task"]')
    : pane.querySelector<HTMLElement>(`[data-shortcut-action="${command}"]`);
  if (!target || target.closest('[hidden], [inert]') || target.getAttribute('aria-disabled') === 'true' || (target as HTMLButtonElement).disabled) return null;
  return target;
}
export function usePaneControlShortcuts(input: { enabled: boolean; focusedPaneId: string; root: RefObject<HTMLDivElement | null>; bindings: Record<string, string> }): void {
  const latest = useRef(input); latest.current = input;
  useEffect(() => {
    if (!input.enabled) return;
    const handle = (event: KeyboardEvent) => {
      const current = latest.current;
      const command = evaluatePaneControlKey(event, { enabled: current.enabled, bindings: current.bindings, target: event.target, platform: resolveHostPlatform(),
        blocked: !!document.querySelector("[aria-modal='true'], [role='dialog'], [role='menu'], .xn-shortcuts__recording") });
      if (!command) return;
      const target = paneControlTarget(current.root.current, current.focusedPaneId, command);
      if (!target) return;
      event.preventDefault(); event.stopPropagation();
      target.focus();
      if (target.tagName !== 'INPUT') target.click();
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [input.enabled]);
}
