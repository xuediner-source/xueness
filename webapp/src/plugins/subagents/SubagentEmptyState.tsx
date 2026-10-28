import React from 'react';
import { Activity, Bot, FileCheck2, ScrollText } from 'lucide-react';
import { t as tr } from '../../i18n';

export function SubagentEmptyState({ kind }: { kind: 'empty' | 'disabled' | 'no-session' }) {
  const title = kind === 'disabled' ? tr('子代理插件已禁用') : kind === 'no-session' ? tr('选择一个会话') : tr('暂无子代理任务');
  return <div className="xn-subagent-sidepane__empty" data-testid={`subagent-sidepane-${kind}`}>
    <div className="xn-subagent-empty-network" aria-hidden="true"><span className="xn-subagent-empty-network__root"><Bot size={26} /></span><span className="xn-subagent-empty-network__child"><Bot size={15} /></span><span className="xn-subagent-empty-network__child"><Bot size={15} /></span></div>
    <p className="xn-subagent-sidepane__empty-title">{title}</p>
    {kind !== 'disabled' && <p className="xn-subagent-sidepane__empty-hint">{kind === 'no-session' ? tr('选择会话后查看子代理任务。') : tr('子任务开始后，这里会显示实时进展、结果摘要与执行记录。')}</p>}
    {kind === 'empty' && <div className="xn-subagent-empty-features"><span><Activity size={13} />{tr('实时进展')}</span><span><FileCheck2 size={13} />{tr('结果摘要')}</span><span><ScrollText size={13} />{tr('执行记录')}</span></div>}
  </div>;
}
