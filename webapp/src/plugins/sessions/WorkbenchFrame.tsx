import React, { useCallback, useState } from 'react';
import { FolderOpen, PanelRight, SquareTerminal } from 'lucide-react';
import { t as tr } from '../../i18n';

export const WORKBENCH_DOCK_PANELS = ['files', 'changes', 'git', 'directory', 'subagents'] as const;
export function isWorkbenchDockPanel(panel: string): boolean {
  return (WORKBENCH_DOCK_PANELS as readonly string[]).includes(panel);
}

/** Session navigation keeps an open tool beside the newly selected conversation. */
export function useWorkbenchLayout<Panel extends string>(initialPanel: Panel) {
  const [panel, updatePanel] = useState(initialPanel);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const setPanel = useCallback((next: Panel | ((previous: Panel) => Panel)) => {
    if (next === 'terminal') {
      setTerminalOpen(true);
      updatePanel(previous => previous === 'chat' || isWorkbenchDockPanel(previous) ? previous : initialPanel);
    } else updatePanel(next);
  }, [initialPanel]);
  const showConversation = useCallback(() => {
    updatePanel(previous => isWorkbenchDockPanel(previous) ? previous : initialPanel);
  }, [initialPanel]);
  return { panel, setPanel, showConversation, terminalOpen, setTerminalOpen };
}

export type WorkbenchToolAction = { id: string; label: string; icon: React.ReactNode; active?: boolean; onClick(): void };

/** Layout only; feature gates and all API-backed content are supplied by the host. */
export function WorkbenchFrame({ appearance, workspace, tabs, tools, menu, terminalOpen, onToggleTerminal, onToggleContext, contextOpen, dock, terminal, children }: {
  appearance: 'zcode' | 'codex';
  workspace: string;
  tabs: React.ReactNode;
  tools: WorkbenchToolAction[];
  menu?: React.ReactNode;
  terminalOpen: boolean;
  onToggleTerminal?: () => void;
  onToggleContext?: () => void;
  contextOpen?: boolean;
  dock?: React.ReactNode;
  terminal?: React.ReactNode;
  children: React.ReactNode;
}) {
  return <div className={`xn-workbench xn-workbench--${appearance}`} data-testid="xn-workbench" data-workbench={appearance}>
    <header className={`xn-workbench__header xn-${appearance}-workbench-header`}>
      <div className="xn-workbench__workspace" title={workspace}><FolderOpen size={16} aria-hidden="true" /><span>{workspace.split(/[/\\]/u).filter(Boolean).pop() || tr('工作区')}</span></div>
      <div className="xn-workbench__tools" role="group" aria-label={tr('工作台工具')}>
        {tools.map(tool => <button key={tool.id} type="button" title={tool.label} aria-label={tool.label} aria-pressed={Boolean(tool.active)} onClick={tool.onClick} data-testid={`xn-workbench-tool-${tool.id}`}>{tool.icon}<span>{tool.label}</span></button>)}
        {onToggleTerminal && <button type="button" title={tr('终端')} aria-label={tr('终端')} aria-pressed={terminalOpen} onClick={onToggleTerminal} data-testid="xn-workbench-tool-terminal"><SquareTerminal size={16} aria-hidden="true" /></button>}
        {onToggleContext && <button type="button" title={tr('会话信息')} aria-label={tr('会话信息')} aria-pressed={Boolean(contextOpen)} onClick={onToggleContext}><PanelRight size={16} aria-hidden="true" /></button>}
        {menu}
      </div>
    </header>
    {appearance === 'zcode' && tabs}
    <div className="xn-workbench__body">
      <div className="xn-workbench__column">
        <div className="xn-workbench__chat" id="xn-workbench-conversation" role={appearance === 'zcode' && tabs ? 'tabpanel' : 'region'} aria-label={tr('会话')}>{children}</div>
        {terminal}
      </div>
      {dock}
    </div>
  </div>;
}
