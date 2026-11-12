/**
 * Settings → 扩展包导入: import declarative packages of any registered type
 * from a local file or folder, preview what they contribute, and manage what
 * is imported. The page knows no package format. The server lists the types
 * (each provided by the plugin that owns the format), recognises a picked
 * manifest, and answers with a format-neutral view; when it asks for more
 * package files, the page sends them from the picked folder. Nothing in a
 * package runs.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Boxes, FolderOpen, PackageOpen, PackagePlus, RefreshCw, ShieldCheck, SquareTerminal, TriangleAlert } from 'lucide-react';
import { get, post } from '../../xuenessApi';
import { t as tr, tf } from '../../i18n';
import { EmptyState } from '../../ui/primitives';
import './package-imports.css';

type Chip = { text: string; tone?: 'warn' };
type View = {
  id: string; version: string; name: string; description: string; author: string;
  facts: { label: string; value: string }[]; counts: { label: string; count: number }[];
  sections: { title: string; rows: { name: string; note?: string; body?: string; chips?: Chip[] }[] }[];
};
type Activation = { state: 'none' | 'inactive' | 'partial' | 'active'; total: number; active: number; review?: number; kinds: { kind: string; total: number; active: number }[] };
type Changed = { ok: boolean; written?: unknown[]; skipped?: { kind: string; id: string; reason: string }[]; error?: Failure['error'] };
type Item = View & { activation?: Activation; type: string; status?: 'ok' | 'attention'; checks?: { label: string; ok: boolean; detail: string }[]; importedAt?: string; fileName?: string; enabled?: boolean; managed?: boolean };
type Preview = View & { replaces: string | null; missing: string[]; wants?: string[]; blocked: boolean; notes: { tone: 'warn' | 'danger'; text: string; args?: string[] }[] };
type PackageType = { type: string; owner: string; name: string; nameEn: string; manifestNames: string[]; available: boolean };
type Listing = { types: PackageType[]; items: Item[]; limits: { manifestBytes: number; fileBytes: number; folderFiles?: number; folderBytes?: number } };
type Failure = { ok: false; error: { code: string; message: string; plugin?: string; issues?: ({ path?: string; message?: string } | string)[] } };
type Body = { manifest: string; files?: { path: string; content: string; encoding?: 'base64' }[]; fileName: string };
/** One manifest to try, and how to fetch the package files the importer asks for. */
type Candidate = { body: Body; file(path: string): File | undefined; folder(patterns: string[]): { path: string; file: File }[] };

const API = '/api/plugins/imports';
const failed = (value: unknown): value is Failure => Boolean(value && typeof value === 'object' && (value as Failure).ok === false);
const relative = (file: File) => (file.webkitRelativePath || file.name).replace(/\\/g, '/');
const cleanPath = (path: string) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
/** A manifest name is exact, or `*.ext` for any file with that ending. */
const nameMatches = (pattern: string, name: string) => pattern.startsWith('*') ? name.toLowerCase().endsWith(pattern.slice(1).toLowerCase()) : name === pattern;
/** `*` matches within one path segment, `**` across segments. */
const wantedPattern = (pattern: string) => new RegExp('^' + pattern.split('**').map(part => part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** The shallowest known manifests in a picked folder, in the registry's order of manifest names. */
async function folderCandidates(list: File[], names: string[], limit: number): Promise<Candidate[]> {
  const depth = (file: File) => relative(file).split('/').length;
  const rank = (file: File) => names.findIndex(pattern => nameMatches(pattern, file.name));
  const known = list.filter(file => rank(file) >= 0).sort((a, b) => depth(a) - depth(b));
  if (!known.length) throw new Error(tf('文件夹里没有可识别的清单文件（{0}）。', [names.join('、')]));
  // One candidate per manifest name: a folder of rule files is one package, not one per file.
  const level = known.filter(file => depth(file) === depth(known[0]!)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).filter((file, index, all) => all.findIndex(other => rank(other) === rank(file)) === index);
  const candidates: Candidate[] = [];
  for (const chosen of level) {
    if (chosen.size > limit) continue;
    const base = relative(chosen).split('/').slice(0, -1).join('/');
    candidates.push({ body: { manifest: await chosen.text(), fileName: relative(chosen) },
      file: path => list.find(item => relative(item) === (base ? `${base}/${cleanPath(path)}` : cleanPath(path))),
      folder: patterns => {
        const tests = patterns.map(wantedPattern);
        return list.filter(item => item !== chosen && (!base || relative(item).startsWith(base + '/')))
          .map(item => ({ path: base ? relative(item).slice(base.length + 1) : relative(item), file: item })).filter(item => tests.some(test => test.test(item.path)));
      } });
  }
  if (!candidates.length) throw new Error(tr('清单文件超过 256 KB。'));
  return candidates;
}

/** The server answers in stable codes; say them plainly. Unknown codes show the server's message. */
const ERROR_TEXT: Record<string, string> = {
  unknown_package_type: '没有已登记的包类型能识别这个清单。',
  ambiguous_package_type: '有多个包类型都能识别这个清单，无法自动选择。',
  code_package: '这是需要运行自身代码的插件包，不能导入。DeepSeek Harness 的代码插件只能在 DSH 中运行；声明式扩展包需要 deepseek-harness.json 或带 xuenessHarness 块的 package.json。',
  invalid_manifest: '清单没有通过校验，按下面的条目修改后再导入。',
  invalid_json: '清单不是有效的 JSON。',
  too_large: '文件超过大小上限：清单最大 256 KB，每个包内文件最大 128 KB。',
  already_imported: '已经导入过同一 ID 的扩展。先移除它，或导入更高的版本后选择替换。',
  managed_package: '官方可选插件请从扩展市场安装和移除。',
};
const errorText = (error: Failure['error']) => error.code === 'type_unavailable' ? tf('这种包类型由「{0}」插件提供，请先在插件管理中启用它。', [error.plugin ?? ''])
  : ERROR_TEXT[error.code] ? tr(ERROR_TEXT[error.code]!) : error.message;

function Counts({ value }: { value: View }) {
  return <ul className="xn-imports-counts">{value.counts.map(({ label, count }) => <li key={label} data-empty={count === 0 || undefined}><strong>{count}</strong>{tr(label)}</li>)}</ul>;
}

function Details({ value }: { value: View }) {
  return <div className="xn-imports-contribs">
    {value.facts.length > 0 && <dl className="xn-imports-factlist">{value.facts.map(fact => <div key={fact.label}><dt>{tr(fact.label)}</dt><dd>{fact.value}</dd></div>)}</dl>}
    {value.sections.map(section => <section key={section.title}><h4>{tr(section.title)}</h4><ul>{section.rows.map((row, index) => <li key={`${row.name}:${index}`}>
      <code>{row.name}</code>{row.chips?.map(chip => <span key={chip.text} className="xn-imports-chip" data-tone={chip.tone}>{tr(chip.text)}</span>)}
      {row.note && <p>{row.note}</p>}{row.body && <pre>{row.body}</pre>}</li>)}</ul></section>)}
  </div>;
}

export function PackageImports({ onManagePlugins }: { onManagePlugins?: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<Failure['error'] | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  const [staged, setStaged] = useState<{ body: Body; type: string; preview: Preview } | null>(null);
  const [picked, setPicked] = useState<File[]>([]);
  const [removing, setRemoving] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const refresh = async (signal: AbortSignal) => {
    try {
      const result = await get<Listing | Failure>(API, signal);
      if (signal.aborted) return;
      if (failed(result)) setError(result.error);
      else setListing(result);
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
  const limits = { manifestBytes: 256 * 1024, fileBytes: 128 * 1024, folderFiles: 100, folderBytes: 600 * 1024, ...listing?.limits };
  const types = listing?.types ?? [];
  const typeName = (type: string) => { const found = types.find(item => item.type === type); return found ? tr(found.name) : type; };
  /** Preview one manifest, then send the package files its importer asks for and preview again. */
  const prepare = async (candidate: Candidate, signal: AbortSignal, type?: string): Promise<{ body: Body & { type?: string }; type: string; preview: Preview } | Failure['error']> => {
    const body: Body & { type?: string } = { ...candidate.body, ...(type ? { type } : {}) };
    let result = await post<{ ok: true; type: string; preview: Preview } | Failure>(`${API}/preview`, body, signal);
    if (failed(result)) return result.error;
    if (result.preview.missing.length) {
      const files: NonNullable<Body['files']> = [];
      for (const path of result.preview.missing) {
        const file = candidate.file(path);
        if (file && file.size <= limits.fileBytes) files.push({ path, content: await file.text() });
      }
      if (files.length) body.files = files;
    }
    if (result.preview.wants?.length) {
      // The importer asked for the package's other files; they travel as bytes.
      const wanted = candidate.folder(result.preview.wants);
      if (wanted.length > limits.folderFiles || wanted.reduce((sum, item) => sum + item.file.size, 0) > limits.folderBytes) {
        return { code: 'too_large', message: tf('文件夹超过导入上限（{0} 个文件，共 {1} KB）。', [limits.folderFiles, Math.floor(limits.folderBytes / 1024)]) };
      }
      for (const item of wanted) body.files = [...(body.files ?? []), { path: item.path, content: await base64(item.file), encoding: 'base64' }];
    }
    if (body.files?.length) {
      result = await post<{ ok: true; type: string; preview: Preview } | Failure>(`${API}/preview`, body, signal);
      if (failed(result)) return result.error;
    }
    return { body, type: result.type, preview: result.preview };
  };
  /** Preview the candidates in order; the first one a registered type recognises is staged. */
  const stage = (read: () => Promise<Candidate[]>) => run(async signal => {
    setStaged(null);
    let refusal: Failure['error'] | null = null;
    for (const candidate of await read()) {
      signal.throwIfAborted();
      const prepared = await prepare(candidate, signal);
      if (signal.aborted) return;
      if ('preview' in prepared) { setStaged(prepared); return; }
      refusal = prepared;
      if (prepared.code !== 'unknown_package_type') break;
    }
    if (refusal) setError(refusal);
  });
  /** Every folder with a SKILL.md in what was picked, for instance the checkout of a plugin written for another harness. */
  const skillManifests = picked.filter(file => file.name === 'SKILL.md');
  const importSkills = () => run(async signal => {
    setStaged(null);
    const done: string[] = [], skipped: string[] = [];
    for (const manifest of skillManifests) {
      signal.throwIfAborted();
      const [candidate] = await folderCandidates(picked.filter(file => relative(file).startsWith(relative(manifest).slice(0, -'SKILL.md'.length))), ['SKILL.md'], limits.manifestBytes);
      const prepared = await prepare(candidate!, signal, 'skill');
      if (signal.aborted) return;
      const folder = relative(manifest).split('/').slice(-2, -1)[0] ?? 'SKILL.md';
      if (!('preview' in prepared) || prepared.preview.blocked) { skipped.push(`${folder}（${'preview' in prepared ? tr('已有同名技能') : errorText(prepared)}）`); continue; }
      const result = await post<{ ok: true; item: Item } | Failure>(`${API}/install`, { ...prepared.body, type: 'skill', replace: prepared.preview.replaces !== null }, signal);
      if (failed(result)) skipped.push(`${folder}（${errorText(result.error)}）`); else done.push(result.item.name);
    }
    setPicked([]);
    setNotice(skipped.length ? tf('已导入 {0} 个技能；未导入：{1}', [done.length, skipped.join('、')]) : tf('已导入 {0} 个技能', [done.length]));
    await refresh(signal);
  });
  const confirm = () => staged && run(async signal => {
    const result = await post<{ ok: true; item: Item } | Failure>(`${API}/install`, { ...staged.body, type: staged.type, replace: staged.preview.replaces !== null }, signal);
    if (signal.aborted) return;
    if (failed(result)) { setError(result.error); return; }
    setNotice(tf('已导入 {0} {1}', [result.item.name, result.item.version ? `v${result.item.version}` : '']).trim()); setStaged(null); await refresh(signal);
  });
  const remove = (item: Item) => run(async signal => {
    const result = await post<{ ok: true } | Failure>(`${API}/remove`, { type: item.type, id: item.id }, signal);
    if (signal.aborted) return;
    if (failed(result)) setError(result.error); else { setNotice(tf('已移除 {0}', [item.id])); setRemoving(''); await refresh(signal); }
  });
  // Unavailable types are tried too: the server then names the plugin to enable.
  const SKIP_REASONS: Record<string, string> = { plugin_disabled: '所属插件未启用', name_taken: '已有同名资源', invalid_id: '名称不可用', empty: '内容为空', too_large: '内容过大', write_failed: '写入失败' };
  const KIND_NAMES: Record<string, string> = { skills: '技能', commands: '命令', hooks: '钩子' };
  const toggle = (item: Item, on: boolean) => run(async signal => {
    const result = await post<Changed>(`${API}/${on ? 'activate' : 'deactivate'}`, { type: item.type, id: item.id }, signal);
    if (signal.aborted) return;
    const skipped = (result.skipped ?? []).map(row => `${tr(KIND_NAMES[row.kind] ?? row.kind)} ${row.id}（${tr(SKIP_REASONS[row.reason] ?? row.reason)}）`).join('、');
    if (!result.ok && result.error) setError({ code: result.error.code, message: skipped ? tf('没有内容被启用：{0}', [skipped]) : result.error.message });
    else setNotice(!on ? tf('已停用 {0}', [item.name]) : skipped ? tf('已启用 {0}，其中未启用：{1}', [item.name, skipped]) : tf('已启用 {0}', [item.name]));
    await refresh(signal);
  });
  const names = [...new Set(types.flatMap(type => type.manifestNames))];
  const items = listing?.items ?? [];
  return <section className="xn-imports" data-testid="package-imports">
    <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) void stage(async () => { if (file.size > limits.manifestBytes) throw new Error(tr('清单文件超过 256 KB。')); return [{ body: { manifest: await file.text(), fileName: file.name }, file: () => undefined, folder: () => [] }]; }); }} />
    <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '', directory: '' }} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
      if (files.length) { setPicked(files); void stage(() => folderCandidates(files, names, limits.manifestBytes)); } }} />
    <div className="xn-imports__intro">
      <p>{tr('从本机导入声明式扩展包：选择包含清单文件的文件夹，或只选清单文件。包类型会自动识别，每种类型由拥有该格式的插件提供。')}</p>
      <div className="xn-imports__pickers">
        <button type="button" className="xn-imports-button xn-imports-button--primary" disabled={busy || !names.length} onClick={() => folderInput.current?.click()}><FolderOpen size={14} aria-hidden="true" />{tr('选择文件夹')}</button>
        <button type="button" className="xn-imports-button" disabled={busy || !names.length} onClick={() => fileInput.current?.click()}><PackageOpen size={14} aria-hidden="true" />{tr('选择清单文件')}</button>
      </div>
    </div>
    {types.length > 0 && <ul className="xn-imports-types" aria-label={tr('可导入的包类型')}>{types.map(type => <li key={type.type} data-off={!type.available || undefined}>
      <strong>{tr(type.name)}</strong><code>{type.manifestNames.join(' / ')}</code>
      {!type.available && <button type="button" className="xn-imports-link" disabled={!onManagePlugins} onClick={onManagePlugins}>{tf('需启用「{0}」插件', [type.owner])}</button>}</li>)}</ul>}
    <ul className="xn-imports__facts">
      <li><ShieldCheck size={14} aria-hidden="true" />{tr('只读取清单和其中引用的文本文件，不运行包里的任何代码。')}</li>
      <li><SquareTerminal size={14} aria-hidden="true" />{tr('包里声明的校验命令和钩子只会列出，不会执行。')}</li>
      <li><FolderOpen size={14} aria-hidden="true" />{tr('来自 GitHub 的扩展：先把仓库下载到本机，再选择其中的文件夹。')}</li>
    </ul>
    {error && <div className="xn-imports__error" role="alert"><TriangleAlert size={15} aria-hidden="true" /><div>
      <strong>{error.code === 'load' ? tr('无法读取已导入的扩展包') : tr('无法导入')}</strong>
      <span>{errorText(error)}</span>
      {!!error.issues?.length && <ul>{error.issues.slice(0, 12).map((issue, index) => typeof issue === 'string' ? <li key={index}>{issue}</li>
        : <li key={index}><code>{issue.path || '/'}</code> {issue.message}</li>)}</ul>}
    </div></div>}
    {notice && <p className="xn-imports__notice" role="status">{notice}</p>}
    {skillManifests.length > 0 && (skillManifests.length > 1 || staged?.type !== 'skill') && <p className="xn-imports__notice" data-testid="import-all-skills">
      {tf('所选文件夹里有 {0} 个技能文件夹（含 SKILL.md）。技能是纯文本，可以单独导入；文件夹里的代码不会被读取或执行。', [skillManifests.length])}{' '}
      <button type="button" className="xn-imports-button xn-imports-button--primary" disabled={busy} onClick={() => void importSkills()}>{tf('导入这 {0} 个技能', [skillManifests.length])}</button></p>}
    {staged && <article className="xn-imports-card xn-imports-card--preview" aria-label={tr('导入预览')}>
      <header><span className="xn-imports-card__icon" aria-hidden="true"><PackagePlus size={17} /></span>
        <div><strong>{staged.preview.name}</strong><span>{staged.preview.id}{staged.preview.version ? ` · v${staged.preview.version}` : ''}{staged.preview.author ? ` · ${staged.preview.author}` : ''}</span></div>
        <span className="xn-imports-chip">{typeName(staged.type)}</span></header>
      {staged.preview.description && <p className="xn-imports-card__description">{staged.preview.description}</p>}
      <Counts value={staged.preview} />
      <Details value={staged.preview} />
      {staged.preview.replaces !== null && <p className="xn-imports__warn">{staged.preview.replaces ? tf('将替换已导入的 v{0}。', [staged.preview.replaces]) : tr('将替换已导入的同名扩展包。')}</p>}
      {staged.preview.missing.length > (staged.body.files?.length ?? 0) && <p className="xn-imports__warn">{tf('有 {0} 个包内文件没有找到，导入后会显示为缺少文件。', [staged.preview.missing.length - (staged.body.files?.length ?? 0)])}</p>}
      {staged.preview.notes.map(note => <p key={note.text} className={note.tone === 'danger' ? 'xn-imports__danger' : 'xn-imports__warn'}>{tf(note.text, note.args ?? [])}</p>)}
      <footer><button type="button" className="xn-imports-button" disabled={busy} onClick={() => setStaged(null)}>{tr('取消')}</button>
        <button type="button" className="xn-imports-button xn-imports-button--primary" disabled={busy || staged.preview.blocked} onClick={() => void confirm()}>
          {staged.preview.replaces !== null ? (staged.preview.version ? tf('替换为 v{0}', [staged.preview.version]) : tr('替换')) : tr('导入')}</button></footer>
    </article>}
    <div className="xn-imports__heading"><h3>{tf('已导入 {0}', [items.length])}</h3>
      <button type="button" className="xn-imports-button" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={13} aria-hidden="true" />{tr('重新检查')}</button></div>
    {!listing ? (busy && <p className="xn-imports__loading" role="status">{tr('正在读取…')}</p>)
      : items.length === 0 ? <EmptyState icon={<Boxes size={18} />} title={tr('还没有导入的扩展包')} hint={tr('导入后，扩展包声明的内容会登记在这里，并随时可以移除。')} />
      : <ul className="xn-imports__list">{items.map(item => {
        const key = `${item.type}:${item.id}`;
        const healthy = item.status !== 'attention';
        return <li key={key} className="xn-imports-card">
          <header><span className="xn-imports-card__icon" aria-hidden="true"><Boxes size={17} /></span>
            <div><strong>{item.name}</strong><span>{item.id}{item.version ? ` · v${item.version}` : ''}{item.author ? ` · ${item.author}` : ''}</span></div>
            <span className="xn-imports-chip" data-category="imported">{tr('导入')}</span><span className="xn-imports-chip">{typeName(item.type)}</span>
            {item.enabled !== undefined && <span className="xn-imports-chip">{item.enabled ? tr('已启用') : tr('未启用')}</span>}
            <span className="xn-imports-status" data-ok={healthy || undefined}>{healthy ? tr('正常') : tr('需要注意')}</span></header>
          {item.description && <p className="xn-imports-card__description">{item.description}</p>}
          <Counts value={item} />
          <details><summary>{tr('查看内容与检查')}</summary>
            <Details value={item} />
            {!!item.checks?.length && <ul className="xn-imports-checks">{item.checks.map(check => <li key={check.label} data-ok={check.ok || undefined}><span>{tr(check.label)}</span>{!check.ok && <small>{check.detail}</small>}</li>)}</ul>}
          </details>
          <footer><small>{item.importedAt ? tf('导入于 {0}', [new Date(item.importedAt).toLocaleString()]) : ''}{item.fileName ? ` · ${item.fileName}` : ''}{item.managed ? tr('由扩展市场管理') : ''}</small>
            {item.activation && item.activation.total > 0 && <span className="xn-imports-card__confirm">
              <small>{item.activation.active > 0 ? tf('已启用 {0}/{1} 项', [item.activation.active, item.activation.total]) : tf('可启用 {0} 项', [item.activation.total])}
                {(item.activation.review ?? 0) > 0 ? ` · ${tf('{0} 个钩子已登记但未开启，请到钩子页面检查命令后逐个启用', [item.activation.review])}` : ''}</small>
              {item.activation.active < item.activation.total && <button type="button" className="xn-imports-button xn-imports-button--primary" disabled={busy} onClick={() => void toggle(item, true)}>{tr('启用')}</button>}
              {item.activation.active > 0 && <button type="button" className="xn-imports-button" disabled={busy} onClick={() => void toggle(item, false)}>{tr('停用')}</button>}</span>}            {item.managed ? null : removing === key
              ? <span className="xn-imports-card__confirm">{tr('移除后需要重新导入。')}<button type="button" className="xn-imports-button" onClick={() => setRemoving('')}>{tr('取消')}</button>
                  <button type="button" className="xn-imports-button xn-imports-button--danger" disabled={busy} onClick={() => void remove(item)}>{tr('移除')}</button></span>
              : <button type="button" className="xn-imports-button" disabled={busy} onClick={() => setRemoving(key)}>{tr('移除')}</button>}
          </footer>
        </li>;
      })}</ul>}
  </section>;
}
