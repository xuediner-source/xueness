/**
 * Settings → DeepSeek Harness: import third-party declarative DSH packages
 * from a local file or folder, preview what they contribute, and manage the
 * imported library. The browser reads the picked files and sends their text;
 * the server validates and stores them. Nothing in a package runs: declared
 * verifier commands and hook handlers are shown, never executed.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Boxes, FolderOpen, PackageOpen, PackagePlus, RefreshCw, ShieldCheck, SquareTerminal, TriangleAlert } from 'lucide-react';
import { get, post } from '../../xuenessApi';
import { t as tr, tf } from '../../i18n';
import { EmptyState } from '../../ui/primitives';
import './harness-library.css';

type Contribs = {
  tools: { name: string; gate: string; mutating: boolean; description?: string }[];
  hooks: { event: string; handler: string }[];
  verifiers: { name: string; command: string }[];
  skills: { id: string; path: string; present?: boolean }[];
  promptTemplates: { id: string; preview?: string; template?: string }[];
};
type Item = Contribs & { id: string; version: string; importedAt: string; kind: string; fileName: string; name: string; description: string; author: string };
type Check = { name: string; ok: boolean; detail: string };
type Library = { items: Item[]; report: { items: { id: string; status: 'ok' | 'degraded'; checks: Check[] }[] } };
type Preview = { id: string; version: string; kind: string; info: { name: string; description: string; author: string }; manifest: Contribs; files: string[]; missing: string[]; replaces: string | null; clashes: string[] };
type Failure = { ok: false; error: { code: string; message: string; issues?: { path: string; message: string }[] } };
type Body = { manifest: string; files: { path: string; content: string }[]; fileName: string };

const API = '/api/deepseek_harness';
const MAX_MANIFEST = 256 * 1024;
const MAX_FILE = 128 * 1024;
const failed = (value: unknown): value is Failure => Boolean(value && typeof value === 'object' && (value as Failure).ok === false);
const relative = (file: File) => (file.webkitRelativePath || file.name).replace(/\\/g, '/');
const cleanPath = (path: string) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
const parseJson = (text: string): unknown => JSON.parse(text.replace(/^﻿/, ''));

/** A picked folder as one import body: the shallowest manifest (package.json with xuenessHarness wins, as in the loader) and its skill files. */
async function readFolder(list: File[]): Promise<Body> {
  const depth = (file: File) => relative(file).split('/').length;
  const candidates = list.filter(file => /(^|\/)(deepseek-harness|package)\.json$/.test(relative(file))).sort((a, b) => depth(a) - depth(b));
  if (!candidates.length) throw new Error(tr('文件夹里没有 deepseek-harness.json 或 package.json。'));
  const level = candidates.filter(file => depth(file) === depth(candidates[0]!));
  const pkg = level.find(file => relative(file).endsWith('package.json'));
  let chosen = level.find(file => relative(file).endsWith('deepseek-harness.json')) ?? pkg!;
  if (pkg && pkg.size <= MAX_MANIFEST) {
    try { const doc = parseJson(await pkg.text()) as { xuenessHarness?: unknown }; if (doc && typeof doc.xuenessHarness === 'object') chosen = pkg; }
    catch { /* The server reports invalid JSON. */ }
  }
  if (chosen.size > MAX_MANIFEST) throw new Error(tr('清单文件超过 256 KB。'));
  const manifest = await chosen.text();
  const base = relative(chosen).split('/').slice(0, -1).join('/');
  let paths: string[] = [];
  try {
    const doc = parseJson(manifest) as { xuenessHarness?: { skills?: unknown }; skills?: unknown };
    const skills = (doc.xuenessHarness ?? doc).skills;
    paths = Array.isArray(skills) ? skills.flatMap(skill => typeof skill?.path === 'string' ? [cleanPath(skill.path)] : []) : [];
  } catch { /* the server reports invalid JSON */ }
  const files: Body['files'] = [];
  for (const path of paths.slice(0, 40)) {
    const file = list.find(item => relative(item) === (base ? `${base}/${path}` : path));
    if (file && file.size <= MAX_FILE) files.push({ path, content: await file.text() });
  }
  return { manifest, files, fileName: relative(chosen) };
}

/** The server answers in stable codes and the loader's English issue text; say both plainly. */
const ERROR_TEXT: Record<string, string> = {
  code_package: '这个 package.json 没有 xuenessHarness 块。需要运行自己代码的包不能导入，可以向作者要一份声明式清单。',
  invalid_manifest: '清单没有通过校验，按下面的条目修改后再导入。',
  invalid_json: '清单不是有效的 JSON。',
  too_large: '文件超过大小上限：清单最大 256 KB，每个技能文件最大 128 KB。',
  already_imported: '已经导入过同一 ID 的扩展。先移除它，或导入更高的版本后选择替换。',
};
const ISSUE_TEXT: [RegExp, string][] = [
  [/^is not a valid harness id$/, 'ID 无效：需以小写字母开头，只能包含小写字母、数字、- 和 _'],
  [/^must be MAJOR\.MINOR\.PATCH$/, '版本号必须是“主版本.次版本.修订号”，例如 1.0.0'],
  [/^must be \d+$/, '必须是 1（当前支持的 SDK 版本）'],
  [/^must be a boolean$/, '必须是 true 或 false'],
  [/^is not a valid (tool name|gate kind|verifier name|event name)$/, '名称格式无效：需以小写字母开头'],
  [/^duplicates contribution/, '与清单中另一个条目重复'],
  [/^must be a non-empty/, '不能为空'],
  [/^lists more than/, '条目超过 200 个'],
  [/^manifest must be a JSON object$/, '清单必须是 JSON 对象'],
];
const issueText = (message: string) => { const hit = ISSUE_TEXT.find(([pattern]) => pattern.test(message)); return hit ? tr(hit[1]) : message; };
const errorText = (error: Failure['error']) => error.code === 'contribution_clash'
  ? tf('这些条目已由其他已导入的扩展提供：{0}', [error.message.split(': ').slice(1).join(': ')])
  : ERROR_TEXT[error.code] ? tr(ERROR_TEXT[error.code]!) : error.message;

const CHECKS: Record<string, string> = { sdk_supported: 'SDK 版本兼容', source_present: '本地副本完整', manifest_current: '清单未变化', contributions_resolved: '技能文件齐全', mounted: '已挂载' };

function Counts({ value }: { value: Contribs }) {
  const counts: [string, number][] = [['工具', value.tools.length], ['钩子', value.hooks.length], ['校验命令', value.verifiers.length], ['技能', value.skills.length], ['提示模板', value.promptTemplates.length]];
  return <ul className="xn-harness-counts">{counts.map(([label, count]) => <li key={label} data-empty={count === 0 || undefined}><strong>{count}</strong>{tr(label)}</li>)}</ul>;
}

function Contributions({ value, missing = [] }: { value: Contribs; missing?: string[] }) {
  return <div className="xn-harness-contribs">
    {value.tools.length > 0 && <section><h4>{tr('工具声明')}</h4><ul>{value.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>
      <span className="xn-harness-chip">{tool.gate}</span>{tool.mutating && <span className="xn-harness-chip" data-tone="warn">{tr('会修改')}</span>}{tool.description && <p>{tool.description}</p>}</li>)}</ul></section>}
    {value.hooks.length > 0 && <section><h4>{tr('钩子声明')}</h4><ul>{value.hooks.map(hook => <li key={`${hook.event}:${hook.handler}`}><code>{hook.event}</code><span>→</span><code>{hook.handler}</code><span className="xn-harness-chip">{tr('不会执行')}</span></li>)}</ul></section>}
    {value.verifiers.length > 0 && <section><h4>{tr('校验命令')}</h4><ul>{value.verifiers.map(verifier => <li key={verifier.name}><code>{verifier.name}</code><span className="xn-harness-chip">{tr('不会执行')}</span>{verifier.command && <pre>{verifier.command}</pre>}</li>)}</ul></section>}
    {value.skills.length > 0 && <section><h4>{tr('技能')}</h4><ul>{value.skills.map(skill => {
      const absent = skill.present === false || missing.includes(cleanPath(skill.path));
      return <li key={skill.id}><code>{skill.id}</code>{skill.path && <span className="xn-harness-path">{skill.path}</span>}{skill.path && absent && <span className="xn-harness-chip" data-tone="warn">{tr('缺少文件')}</span>}</li>;
    })}</ul></section>}
    {value.promptTemplates.length > 0 && <section><h4>{tr('提示模板')}</h4><ul>{value.promptTemplates.map(template => <li key={template.id}><code>{template.id}</code><p>{(template.preview ?? template.template ?? '').slice(0, 240)}</p></li>)}</ul></section>}
  </div>;
}

export function HarnessLibrary() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState<Failure['error'] | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  const [staged, setStaged] = useState<{ body: Body; preview: Preview } | null>(null);
  const [removing, setRemoving] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const refresh = async (signal: AbortSignal) => {
    try {
      const result = await get<Library | Failure>(API, signal);
      if (signal.aborted) return;
      if (failed(result)) setError(result.error);
      else setLibrary(result);
    } catch (cause) {
      if (!signal.aborted) setError({ code: 'load', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void refresh(controller.signal).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true); setError(null); setNotice('');
    try { await task(signal); }
    catch (cause) { if (!signal.aborted) setError({ code: 'local', message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const stage = (read: () => Promise<Body>) => run(async signal => {
    setStaged(null);
    const body = await read();
    signal.throwIfAborted();
    const result = await post<{ ok: true; preview: Preview } | Failure>(`${API}/preview`, body, signal);
    if (signal.aborted) return;
    if (failed(result)) setError(result.error);
    else setStaged({ body, preview: result.preview });
  });
  const confirm = () => staged && run(async signal => {
    const result = await post<{ ok: true; item: Item } | Failure>(`${API}/import`, { ...staged.body, replace: staged.preview.replaces !== null }, signal);
    if (signal.aborted) return;
    if (failed(result)) { setError(result.error); return; }
    setNotice(tf('已导入 {0} {1}', [result.item.name, `v${result.item.version}`])); setStaged(null); await refresh(signal);
  });
  const remove = (id: string) => run(async signal => {
    const result = await post<{ ok: true } | Failure>(`${API}/remove`, { id }, signal);
    if (signal.aborted) return;
    if (failed(result)) setError(result.error); else { setNotice(tf('已移除 {0}', [id])); setRemoving(''); await refresh(signal); }
  });
  const report = new Map((library?.report.items ?? []).map(item => [item.id, item]));
  const pickers = <div className="xn-harness__pickers">
    <button type="button" className="xn-harness-button xn-harness-button--primary" disabled={busy} onClick={() => folderInput.current?.click()}><FolderOpen size={14} aria-hidden="true" />{tr('选择文件夹')}</button>
    <button type="button" className="xn-harness-button" disabled={busy} onClick={() => fileInput.current?.click()}><PackageOpen size={14} aria-hidden="true" />{tr('选择清单文件')}</button>
  </div>;
  return <section className="xn-harness" data-testid="harness-library">
    <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) void stage(async () => { if (file.size > MAX_MANIFEST) throw new Error(tr('清单文件超过 256 KB。')); return { manifest: await file.text(), files: [], fileName: file.name }; }); }} />
    <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '', directory: '' }} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) void stage(() => readFolder(files)); }} />
    <div className="xn-harness__intro">
      <p>{tr('导入其他作者为 DeepSeek Harness 制作的声明式扩展包：选择包含 deepseek-harness.json（或带 xuenessHarness 的 package.json）的文件夹，或只选清单文件。')}</p>
      {pickers}
    </div>
    <ul className="xn-harness__facts">
      <li><ShieldCheck size={14} aria-hidden="true" />{tr('只读取清单和其中引用的技能文件，不运行包里的任何代码。')}</li>
      <li><SquareTerminal size={14} aria-hidden="true" />{tr('包里声明的校验命令和钩子只会列出，不会执行。')}</li>
      <li><FolderOpen size={14} aria-hidden="true" />{tr('来自 GitHub 的扩展：先把仓库下载到本机，再选择其中的文件夹。')}</li>
    </ul>
    {error && <div className="xn-harness__error" role="alert"><TriangleAlert size={15} aria-hidden="true" /><div>
      <strong>{error.code === 'code_package' ? tr('这个包需要运行自己的代码，不能导入') : error.code === 'already_imported' ? tr('已经导入过同名扩展') : error.code === 'contribution_clash' ? tr('与已导入的扩展冲突') : tr('无法导入')}</strong>
      <span>{errorText(error)}</span>
      {!!error.issues?.length && <ul>{error.issues.slice(0, 12).map((issue, index) => <li key={index}><code>{issue.path || '/'}</code> {issueText(issue.message)}</li>)}</ul>}
    </div></div>}
    {notice && <p className="xn-harness__notice" role="status">{notice}</p>}
    {staged && <article className="xn-harness-card xn-harness-card--preview" aria-label={tr('导入预览')}>
      <header><span className="xn-harness-card__icon" aria-hidden="true"><PackagePlus size={17} /></span>
        <div><strong>{staged.preview.info.name}</strong><span>{staged.preview.id} · v{staged.preview.version}{staged.preview.info.author ? ` · ${staged.preview.info.author}` : ''}</span></div>
        <span className="xn-harness-chip">{staged.preview.kind === 'package' ? 'package.json' : 'deepseek-harness.json'}</span></header>
      {staged.preview.info.description && <p className="xn-harness-card__description">{staged.preview.info.description}</p>}
      <Counts value={staged.preview.manifest} />
      <Contributions value={staged.preview.manifest} missing={staged.preview.missing} />
      {staged.preview.replaces && <p className="xn-harness__warn">{tf('将替换已导入的 v{0}。', [staged.preview.replaces])}</p>}
      {staged.preview.missing.length > 0 && <p className="xn-harness__warn">{tf('有 {0} 个技能文件没有找到，导入后会显示为缺少文件。', [staged.preview.missing.length])}</p>}
      {staged.preview.clashes.length > 0 && <p className="xn-harness__danger">{tf('与已导入的扩展冲突：{0}。请先移除冲突的扩展。', [staged.preview.clashes.join('、')])}</p>}
      <footer><button type="button" className="xn-harness-button" disabled={busy} onClick={() => setStaged(null)}>{tr('取消')}</button>
        <button type="button" className="xn-harness-button xn-harness-button--primary" disabled={busy || staged.preview.clashes.length > 0} onClick={() => void confirm()}>
          {staged.preview.replaces ? tf('替换为 v{0}', [staged.preview.version]) : tr('导入')}</button></footer>
    </article>}
    <div className="xn-harness__heading"><h3>{tf('已导入 {0}', [library?.items.length ?? 0])}</h3>
      <button type="button" className="xn-harness-button" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={13} aria-hidden="true" />{tr('重新检查')}</button></div>
    {!library ? (busy && <p className="xn-harness__loading" role="status">{tr('正在读取…')}</p>)
      : library.items.length === 0 ? <EmptyState icon={<Boxes size={18} />} title={tr('还没有导入的扩展包')} hint={tr('导入后，扩展包声明的工具、钩子、技能和提示模板会登记在这里，并随时可以移除。')} />
      : <ul className="xn-harness__list">{library.items.map(item => {
        const checks = report.get(item.id);
        const healthy = checks?.status !== 'degraded';
        return <li key={item.id} className="xn-harness-card">
          <header><span className="xn-harness-card__icon" aria-hidden="true"><Boxes size={17} /></span>
            <div><strong>{item.name}</strong><span>{item.id} · v{item.version}{item.author ? ` · ${item.author}` : ''}</span></div>
            <span className="xn-harness-status" data-ok={healthy || undefined}>{healthy ? tr('正常') : tr('需要注意')}</span></header>
          {item.description && <p className="xn-harness-card__description">{item.description}</p>}
          <Counts value={item} />
          <details><summary>{tr('查看内容与检查')}</summary>
            <Contributions value={item} />
            {checks && <ul className="xn-harness-checks">{checks.checks.map(check => <li key={check.name} data-ok={check.ok || undefined}><span>{tr(CHECKS[check.name] ?? check.name)}</span>{!check.ok && <small>{check.detail}</small>}</li>)}</ul>}
          </details>
          <footer><small>{tf('导入于 {0}', [new Date(item.importedAt).toLocaleString()])}{item.fileName ? ` · ${item.fileName}` : ''}</small>
            {removing === item.id
              ? <span className="xn-harness-card__confirm">{tr('移除后需要重新导入。')}<button type="button" className="xn-harness-button" onClick={() => setRemoving('')}>{tr('取消')}</button>
                  <button type="button" className="xn-harness-button xn-harness-button--danger" disabled={busy} onClick={() => void remove(item.id)}>{tr('移除')}</button></span>
              : <button type="button" className="xn-harness-button" disabled={busy} onClick={() => setRemoving(item.id)}>{tr('移除')}</button>}
          </footer>
        </li>;
      })}</ul>}
  </section>;
}
