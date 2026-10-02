import React, { useEffect, useState } from 'react';
import { post } from '../../xuenessApi';
import { t } from '../../i18n';
import './CompletionChecks.css';

export type DeliveryRequirement = { id: string; label: string; path?: string | null; contains: string[]; min_links: number };
export type CompletionAssessment = {
  verified?: boolean; tool_execution_success?: boolean; delivery_status?: string;
  delivery_checks?: Record<string, { status: string; reason?: string; scope?: string; items?: (DeliveryRequirement & { passed: boolean; missing: string[] })[] }>;
};

export function CompletionChecks({ sessionId, completion, items, disabled, onSaved }: {
  sessionId: string; completion?: CompletionAssessment | null; items: DeliveryRequirement[];
  disabled?: boolean; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(items);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The workbench can reconstruct an equivalent requirements array on each
  // render. Sync only when its content changes so a parent refresh does not
  // erase an in-progress edit.
  const itemsSignature = JSON.stringify(items);
  useEffect(() => {
    setDraft(JSON.parse(itemsSignature) as DeliveryRequirement[]);
    setEditing(false);
    setError('');
  }, [sessionId, itemsSignature]);
  const check = completion?.delivery_checks?.planning;
  const toolOk = completion?.tool_execution_success ?? completion?.verified;
  const update = (index: number, patch: Partial<DeliveryRequirement>) => setDraft(current => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  const save = async () => {
    setSaving(true); setError('');
    try { await post(`/api/delivery/${encodeURIComponent(sessionId)}`, { items: draft }); setEditing(false); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('保存失败')); }
    finally { setSaving(false); }
  };
  const deliveryStatus = completion?.delivery_status ?? 'unchecked';
  return <details className="xn-delivery-checks" data-delivery-status={deliveryStatus}
    open={deliveryStatus === 'failed'}>
    <summary className="xn-delivery-checks__summary">
      <span className="xn-delivery-checks__title">{t('交付检查')}</span>
      <span className="xn-delivery-checks__badges">
        <span className="xn-delivery-checks__badge" data-status={toolOk ? 'passed' : 'failed'}>
          {toolOk ? t('工具执行成功') : t('工具成功证据未通过')}
        </span>
        <span className="xn-delivery-checks__badge" data-status={deliveryStatus === 'passed' ? 'passed' : deliveryStatus === 'failed' ? 'failed' : 'unchecked'}>
          {deliveryStatus === 'passed' ? t('交付检查通过') : deliveryStatus === 'failed' ? t('交付检查未通过') : t('交付内容尚未检查')}
        </span>
      </span>
    </summary>
    <div className="xn-delivery-checks__body">
      <p className="xn-delivery-checks__intro">{t('工具成功只证明引用的调用成功；交付检查另行核对文件、必需条目和链接数量。')}</p>
      {check?.reason && <p className="xn-delivery-checks__reason" role="status">{check.reason}</p>}
      {check?.items?.map(item => <div className="xn-delivery-checks__item" data-status={item.passed ? 'passed' : 'failed'} key={item.id}>
        <strong>{item.passed ? '✓ ' : '○ '}{item.label}</strong>
        {item.missing.length > 0 && <ul>{item.missing.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      </div>)}
      {check?.scope && <small className="xn-delivery-checks__scope">{check.scope}</small>}
      {!completion && items.map(item => <p className="xn-delivery-checks__listed-item" key={item.id}>
        <strong>{item.label}</strong>{item.path && <span>{item.path}</span>}
      </p>)}
      <button className="xn-delivery-checks__button" type="button" disabled={disabled || saving}
        onClick={() => { setDraft(items); setEditing(value => !value); }}>
        {t(editing ? '取消编辑' : '编辑交付清单')}
      </button>
      {editing && <div className="xn-delivery-checks__editor">
        {draft.map((item, index) => <fieldset className="xn-delivery-checks__requirement" key={item.id} disabled={disabled || saving}>
          <legend>{item.label || t('交付项目')}</legend>
          <label>{t('交付项目')}<input value={item.label} maxLength={500} onChange={event => update(index, { label: event.target.value })} /></label>
          <label>{t('目标文件（可选）')}<input value={item.path ?? ''} onChange={event => update(index, { path: event.target.value || null })} /></label>
          <label>{t('必需人物或内容（每行一项）')}<textarea value={item.contains.join('\n')} onChange={event => update(index, { contains: event.target.value.split('\n').filter(Boolean) })} /></label>
          <label>{t('最少来源链接')}<input type="number" min={0} max={100} value={item.min_links} onChange={event => update(index, { min_links: Number(event.target.value) })} /></label>
          <button className="xn-delivery-checks__button xn-delivery-checks__button--quiet" type="button"
            onClick={() => setDraft(current => current.filter((_, i) => i !== index))}>{t('移除')}</button>
        </fieldset>)}
        <div className="xn-delivery-checks__actions">
          <button className="xn-delivery-checks__button" type="button" disabled={disabled || saving || draft.length >= 40}
            onClick={() => setDraft(current => [...current, { id: `user_${Date.now()}`, label: '', path: null, contains: [], min_links: 0 }])}>
            {t('添加交付项目')}
          </button>
          <button className="xn-delivery-checks__button xn-delivery-checks__button--primary" type="button"
            disabled={disabled || saving} onClick={() => void save()}>
            {t(saving ? '保存中…' : '保存清单')}
          </button>
        </div>
      </div>}
      {error && <p className="xn-delivery-checks__error" role="alert">{error}</p>}
    </div>
  </details>;
}
