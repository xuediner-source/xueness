import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import { t as tr, tf } from '../../i18n';
import { addWorkbuddyAccount, deleteWorkbuddyAccount, listWorkbuddyAccounts, readWorkbuddyCredentialsFile, type CredentialFileError, type WorkbuddyAccount, type WorkbuddyAccountsResult } from './api';
import './workbuddy.css';

type Operation = 'refresh' | 'add' | 'delete';
export type DeleteConfirmation = string | null;
export type DeleteConfirmationAction =
  | { type: 'request'; accountId: string }
  | { type: 'cancel' }
  | { type: 'complete'; accountId: string };

export function deleteConfirmationReducer(state: DeleteConfirmation, action: DeleteConfirmationAction): DeleteConfirmation {
  if (action.type === 'request') return action.accountId;
  if (action.type === 'cancel') return null;
  return state === action.accountId ? null : state;
}

type AccountStatus = 'available' | 'cooling' | 'disabled' | 'offline' | 'unknown';
function accountStatus(account: WorkbuddyAccount, gatewayAvailable?: boolean): AccountStatus {
  if (account.disabled) return 'disabled';
  if (account.cooling) return 'cooling';
  if (gatewayAvailable === true) return account.credits !== null || account.lastSuccess !== null || account.inFlight > 0 ? 'available' : 'unknown';
  if (gatewayAvailable === false) return 'offline';
  return 'unknown';
}

function statusLabel(status: AccountStatus) {
  return tr(({ available: '可用', cooling: '冷却中', disabled: '停用', offline: '离线', unknown: '未知' } as const)[status]);
}

function formatDate(value: string | null) {
  if (!value) return tr('暂无');
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function WorkbuddyEmptyState() {
  return <div className="xn-workbuddy__empty" role="status">
    <h3>{tr('尚无 WorkBuddy 账号')}</h3>
    <p>{tr('选择单个 .json 认证文件即可添加账号。')}</p>
  </div>;
}

export function WorkbuddyAccountCard({
  account, gatewayAvailable, deleteConfirmation, disabled = false, onDeleteRequest, onDeleteConfirm, onDeleteCancel,
}: {
  account: WorkbuddyAccount;
  gatewayAvailable: boolean;
  deleteConfirmation: DeleteConfirmation;
  disabled?: boolean;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  onDeleteCancel: () => void;
}) {
  const status = accountStatus(account, gatewayAvailable);
  const nickname = account.nickname || tr('未知');
  return <article className="xn-workbuddy__account" data-testid={`workbuddy-account-${account.id}`}>
    <header className="xn-workbuddy__account-heading">
      <div><h3>{nickname}</h3><p>{tr('UID')} <code>{account.uid || tr('未知')}</code></p></div>
      <span className={`xn-workbuddy__badge is-${status}`} data-state={status}>{statusLabel(status)}</span>
    </header>
    <dl className="xn-workbuddy__details">
      <div><dt>{tr('剩余额度')}</dt><dd>{account.credits === null ? tr('未报告') : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(account.credits)}</dd></div>
      <div><dt>{tr('在途请求')}</dt><dd>{account.inFlight}</dd></div>
      <div><dt>{tr('最近成功')}</dt><dd>{formatDate(account.lastSuccess)}</dd></div>
      {account.cooling && account.cooldownUntil && <div><dt>{tr('冷却中')}</dt><dd>{tf('冷却至：{0}', [formatDate(account.cooldownUntil)])}</dd></div>}
    </dl>
    {account.lastError && <p className="xn-workbuddy__account-error"><strong>{tr('错误')}：</strong>{account.lastError}</p>}
    <footer className="xn-workbuddy__account-actions">
      {deleteConfirmation === account.id ? <>
        <span>{tr('删除此账号？')}</span>
        <button type="button" disabled={disabled} onClick={() => onDeleteConfirm(account.id)}>{tr('确认删除')}</button>
        <button type="button" disabled={disabled} onClick={onDeleteCancel}>{tr('取消')}</button>
      </> : <button type="button" disabled={disabled} onClick={() => onDeleteRequest(account.id)}>
        <Trash2 size={14} aria-hidden="true" />{tr('删除账号')}
      </button>}
    </footer>
  </article>;
}

function credentialFileError(reason: unknown): string {
  const code = reason instanceof Error ? reason.message as CredentialFileError : '';
  const messages: Partial<Record<CredentialFileError, string>> = {
    'workbuddy-file-extension': '仅支持 .json 认证文件。',
    'workbuddy-file-read': '无法读取认证文件。',
    'workbuddy-file-json': '认证文件必须包含 JSON 对象。',
  };
  return tr((code ? messages[code] : undefined) ?? '无法读取认证文件。');
}

export function WorkbuddySettingsPanel() {
  const [snapshot, setSnapshot] = useState<WorkbuddyAccountsResult | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleteConfirmation, dispatchDeleteConfirmation] = useReducer(deleteConfirmationReducer, null);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const begin = useCallback((operation: Operation) => {
    if (!active.current || request.current) return null;
    const controller = new AbortController();
    request.current = controller;
    setBusy(operation); setError(''); setNotice('');
    return controller;
  }, []);
  const finish = useCallback((controller: AbortController) => {
    if (request.current !== controller) return;
    request.current = null;
    if (active.current && !controller.signal.aborted) setBusy(null);
  }, []);

  const refresh = useCallback(async () => {
    const controller = begin('refresh');
    if (!controller) return;
    try {
      const payload = await listWorkbuddyAccounts(controller.signal);
      if (active.current && !controller.signal.aborted) setSnapshot(payload);
    } catch (reason) {
      if (active.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { finish(controller); }
  }, [begin, finish]);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [refresh]);

  const addFile = async (file: File) => {
    const controller = begin('add');
    if (!controller) return;
    try {
      const credentials = await readWorkbuddyCredentialsFile(file);
      const payload = await addWorkbuddyAccount(credentials, controller.signal);
      if (active.current && !controller.signal.aborted) {
        setSnapshot(payload); setNotice(tr('账号已添加。'));
      }
    } catch (reason) {
      if (active.current && !controller.signal.aborted) {
        setError(reason instanceof Error && reason.message.startsWith('workbuddy-file-') ? credentialFileError(reason) : reason instanceof Error ? reason.message : String(reason));
      }
    } finally { finish(controller); }
  };

  const removeAccount = async (id: string) => {
    if (deleteConfirmation !== id) return;
    const controller = begin('delete');
    if (!controller) return;
    try {
      const payload = await deleteWorkbuddyAccount(id, controller.signal);
      if (active.current && !controller.signal.aborted) {
        setSnapshot(payload); setNotice(tr('账号已删除。'));
        dispatchDeleteConfirmation({ type: 'complete', accountId: id });
      }
    } catch (reason) {
      if (active.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { finish(controller); }
  };

  const accounts = snapshot?.accounts ?? [];
  const isBusy = busy !== null;
  return <section className="xn-workbuddy" data-testid="workbuddy-settings" aria-busy={isBusy || snapshot === null}>
    <header className="xn-workbuddy__header">
      <div><h2>{tr('WorkBuddy 号池')}</h2><p>{tr('查看本机 WorkBuddy 账号状态并管理认证文件。')}</p></div>
      <div className="xn-workbuddy__toolbar">
        <button type="button" disabled={isBusy} onClick={() => void refresh()}>
          {busy === 'refresh' ? <LoaderCircle size={15} aria-hidden="true" className="is-spinning" /> : <RefreshCw size={15} aria-hidden="true" />}{tr('刷新状态')}
        </button>
        <button type="button" disabled={isBusy} onClick={() => fileInput.current?.click()}>
          {busy === 'add' ? <LoaderCircle size={15} aria-hidden="true" className="is-spinning" /> : <UserPlus size={15} aria-hidden="true" />}{tr('添加账号')}
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label={tr('添加账号')}
          onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void addFile(file); }} />
      </div>
    </header>
    <p className="xn-workbuddy__local-note">{tr('凭据仅保存在本机，不会随发行包分发。')}</p>
    {snapshot && <p className={`xn-workbuddy__gateway ${snapshot.gatewayAvailable ? 'is-available' : 'is-offline'}`} role="status">
      {tr(snapshot.gatewayAvailable ? 'WorkBuddy 网关可用' : 'WorkBuddy 网关离线')}
    </p>}
    {busy && <p className="xn-workbuddy__busy" role="status">{tr(({ refresh: '正在刷新状态…', add: '正在添加账号…', delete: '正在删除账号…' } as const)[busy])}</p>}
    {error && <p className="xn-workbuddy__error" role="alert">{error}</p>}
    {notice && <p className="xn-workbuddy__notice" role="status">{notice}</p>}
    {snapshot === null && !error && <p className="xn-workbuddy__loading" role="status">{tr('正在加载 WorkBuddy 账号…')}</p>}
    {snapshot && accounts.length === 0 && <WorkbuddyEmptyState />}
    {accounts.length > 0 && <div className="xn-workbuddy__accounts">
      {accounts.map(account => <WorkbuddyAccountCard key={account.id} account={account} gatewayAvailable={snapshot!.gatewayAvailable}
        deleteConfirmation={deleteConfirmation} disabled={isBusy}
        onDeleteRequest={id => dispatchDeleteConfirmation({ type: 'request', accountId: id })}
        onDeleteConfirm={id => void removeAccount(id)} onDeleteCancel={() => dispatchDeleteConfirmation({ type: 'cancel' })} />)}
    </div>}
  </section>;
}
