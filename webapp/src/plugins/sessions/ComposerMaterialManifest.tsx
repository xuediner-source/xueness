import React from 'react';
import { tf, t as tr } from '../../i18n';
import type { ComposerMaterial } from './composerMaterialSummary';

const stateLabel: Record<ComposerMaterial['state'], string> = {
  included: '随本条消息提交',
  'not-ready': '未就绪，不会发送',
  'not-selected': '尚未加入本条消息',
  unavailable: '当前不可用，不会发送',
};

const kindLabel: Record<ComposerMaterial['kind'], string> = {
  attachment: '附件',
  file: '文件',
  session: '会话',
  skill: '技能',
  plugin: '插件',
  capability: '能力',
};

export function ComposerMaterialManifest({ materials }: { materials: ComposerMaterial[] }) {
  if (!materials.length) return null;
  const included = materials.filter(item => item.state === 'included').length;
  const excluded = materials.length - included;
  return <details className="xn-composer-materials" data-testid="composer-material-manifest"
    style={{ margin: '4px 12px 8px', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--fg)', fontSize: 12 }}>
    <summary style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <span>{tr('本条消息材料')}</span>
      <span style={{ color: 'var(--fg-muted)' }}>{tf('{0} 项会随消息提交', [included])}</span>
      {excluded > 0 && <span className="xn-composer-materials__warning" style={{ color: 'var(--warn-fg)' }}>{tf('{0} 项不会随本条消息提交', [excluded])}</span>}
    </summary>
    <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 6 }}>
      {materials.map(item => <li key={item.id} data-material-state={item.state}>
        <span>{tr(kindLabel[item.kind])} · {item.label}</span>
        <small style={{ display: 'block', color: item.state === 'included' ? 'var(--fg-muted)' : 'var(--warn-fg)' }}>{tr(stateLabel[item.state])}</small>
        {item.note && <small style={{ display: 'block', color: 'var(--fg-muted)' }}>{tr(item.note)}</small>}
      </li>)}
    </ul>
  </details>;
}
