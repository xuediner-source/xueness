/**
 * Settings → 酒馆: a library of SillyTavern-compatible character cards and world books, and a button that
 * starts a roleplay. A PNG card carries its definition in a text chunk; it is read here, in the browser, and
 * only that JSON is sent, so the picture never leaves this page. Starting a roleplay asks the server for the
 * opening brief and puts it into the composer of a new chat; the person reads it and sends it.
 */
import { useEffect, useRef, useState } from 'react';
import { BookOpen, MessageSquarePlus, TriangleAlert, Upload, UserRound } from 'lucide-react';
import { del, get, post } from '../../xuenessApi';
import { t as tr, tf } from '../../i18n';
import { EmptyState } from '../../ui/primitives';
import './tavern.css';

type CharacterRow = { id: string; name: string; creator: string; tags: string[]; spec: string; description: string; scenario: string; greetings: string[]; bookEntries: number; hasExamples: boolean; fileName: string };
type BookRow = { id: string; name: string; description: string; entries: number; constant: number; disabled: number; fileName: string };
type Library = { characters: CharacterRow[]; worldbooks: BookRow[]; limits: { cardBytes: number; items: number } };
type Failure = { ok: false; error: { code: string; message: string } };
type Brief = { ok: true; character: string; text: string; greeting: string; worldEntries: number; truncated: boolean };

const API = '/api/tavern';
const failed = (value: unknown): value is Failure => Boolean(value && typeof value === 'object' && (value as Failure).ok === false);
const ERRORS: Record<string, string> = {
  invalid_json: '文件不是有效的 JSON。', invalid_card: '这不是可用的角色卡：需要名称，以及描述、性格或开场白之一。', invalid_book: '这个世界书里没有可用的条目。',
  too_large: '文件内容超过大小上限。', library_full: '资料库已满，请先移除一些条目。', not_found: '没有找到这个条目，请刷新后重试。', no_card_in_png: '这张 PNG 里没有角色卡数据。',
};

/** The card JSON inside a PNG character card: a `tEXt` chunk named `ccv3` (V3) or `chara` (V1/V2), base64 of UTF-8 JSON. */
export function cardJsonFromPng(bytes: Uint8Array): string | null {
  const text = (part: Uint8Array) => { let out = ''; for (let i = 0; i < part.length; i += 0x8000) out += String.fromCharCode(...part.subarray(i, i + 0x8000)); return out; };
  const found: Record<string, string> = {};
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
    const type = text(bytes.subarray(offset + 4, offset + 8));
    if (type === 'IEND' || offset + 12 + length > bytes.length) break;
    if (type === 'tEXt') {
      const data = bytes.subarray(offset + 8, offset + 8 + length), split = data.indexOf(0);
      if (split > 0) found[text(data.subarray(0, split))] = text(data.subarray(split + 1));
    }
    offset += 12 + length;
  }
  const encoded = found.ccv3 ?? found.chara;
  if (!encoded) return null;
  try { return new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))); } catch { return null; }
}

async function cardText(file: File): Promise<string> {
  if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) return file.text();
  const card = cardJsonFromPng(new Uint8Array(await file.arrayBuffer()));
  if (card === null) throw Object.assign(new Error('no card'), { code: 'no_card_in_png' });
  return card;
}

export function TavernPanel({ onStart }: { onStart(text: string): void }) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  const [userName, setUserName] = useState('');
  const [books, setBooks] = useState<string[]>([]);
  const [greetings, setGreetings] = useState<Record<string, number>>({});
  const cardInput = useRef<HTMLInputElement>(null);
  const bookInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const explain = (cause: unknown) => {
    const code = failed(cause) ? cause.error.code : (cause as { code?: string } | null)?.code ?? '';
    setError(ERRORS[code] ? tr(ERRORS[code]!) : failed(cause) ? cause.error.message : cause instanceof Error ? cause.message : String(cause));
  };
  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await task(); } catch (cause) { if (alive.current) explain(cause); } finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true;
    void run(async () => { const result = await get<Library>(API); if (alive.current) setLibrary(result); });
    return () => { alive.current = false; };
  }, []);
  const importFiles = (kind: 'characters' | 'worldbooks', files: File[]) => run(async () => {
    let added = 0;
    for (const file of files) {
      const content = kind === 'characters' ? await cardText(file) : await file.text();
      const result = await post<({ ok: true } & Library) | Failure>(`${API}/${kind}`, kind === 'characters' ? { card: content, fileName: file.name } : { book: content, fileName: file.name });
      if (failed(result)) { explain(result); break; }
      added += 1; setLibrary(result);
    }
    if (added) setNotice(kind === 'characters' ? tf('已导入 {0} 张角色卡', [added]) : tf('已导入 {0} 本世界书', [added]));
  });
  const remove = (kind: 'characters' | 'worldbooks', id: string) => run(async () => {
    const result = await del<({ ok: true } & Library) | Failure>(`${API}/${kind}/${encodeURIComponent(id)}`);
    if (failed(result)) explain(result); else { setLibrary(result); setBooks(current => current.filter(item => item !== id)); }
  });
  const start = (character: CharacterRow) => run(async () => {
    const result = await post<Brief | Failure>(`${API}/brief`, { characterId: character.id, userName, greeting: greetings[character.id] ?? 0, worldbooks: books });
    if (failed(result)) { explain(result); return; }
    onStart(result.text);
    setNotice(tf('已把 {0} 的开场设定放进新对话的输入框，检查后发送即可开始。', [result.character]));
  });
  const characters = library?.characters ?? [], worldbooks = library?.worldbooks ?? [];
  return <section className="xn-tavern" data-testid="tavern-panel">
    <input ref={cardInput} type="file" accept=".json,.png,application/json,image/png" multiple hidden onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) void importFiles('characters', files); }} />
    <input ref={bookInput} type="file" accept=".json,application/json" multiple hidden onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) void importFiles('worldbooks', files); }} />
    <div className="xn-tavern__intro">
      <p>{tr('导入 SillyTavern 兼容的角色卡（JSON 或 PNG）和世界书，从角色设定开始一段对话。角色卡只作为数据读取；PNG 中的设定在浏览器里取出，图片不会上传。')}</p>
      <div className="xn-tavern__actions">
        <button type="button" className="xn-tavern-button xn-tavern-button--primary" disabled={busy} onClick={() => cardInput.current?.click()}><Upload size={14} aria-hidden="true" />{tr('导入角色卡')}</button>
        <button type="button" className="xn-tavern-button" disabled={busy} onClick={() => bookInput.current?.click()}><BookOpen size={14} aria-hidden="true" />{tr('导入世界书')}</button>
      </div>
    </div>
    <label className="xn-tavern__field"><span>{tr('你在故事里的名字')}</span>
      <input type="text" value={userName} maxLength={60} placeholder="User" onChange={event => setUserName(event.currentTarget.value)} /></label>
    {error && <p className="xn-tavern__error" role="alert"><TriangleAlert size={15} aria-hidden="true" />{error}</p>}
    {notice && <p className="xn-tavern__notice" role="status">{notice}</p>}
    <h3>{tf('角色 {0}', [characters.length])}</h3>
    {!library ? (busy && <p className="xn-tavern__muted" role="status">{tr('正在读取…')}</p>)
      : characters.length === 0 ? <EmptyState icon={<UserRound size={18} />} title={tr('还没有角色')} hint={tr('导入一张角色卡后，就可以从它的设定和开场白开始对话。')} />
      : <ul className="xn-tavern__list">{characters.map(character => <li key={character.id} className="xn-tavern-card">
        <header><strong>{character.name}</strong><span>{[character.creator, character.spec.replace('chara_card_', '').toUpperCase(), ...character.tags.slice(0, 4)].filter(Boolean).join(' · ')}</span></header>
        {character.description && <p>{character.description}</p>}
        <small>{[character.bookEntries ? tf('内嵌世界信息 {0} 条', [character.bookEntries]) : '', character.hasExamples ? tr('含示例对话') : '', character.fileName].filter(Boolean).join(' · ')}</small>
        <footer>
          {character.greetings.length > 1 && <select aria-label={tr('开场白')} value={greetings[character.id] ?? 0} onChange={event => { const index = Number(event.currentTarget.value); setGreetings(current => ({ ...current, [character.id]: index })); }}>
            {character.greetings.map((greeting, index) => <option key={index} value={index}>{tf('开场白 {0}', [index + 1])}：{greeting.slice(0, 40)}</option>)}</select>}
          <button type="button" className="xn-tavern-button" disabled={busy} onClick={() => void remove('characters', character.id)}>{tr('移除')}</button>
          <button type="button" className="xn-tavern-button xn-tavern-button--primary" disabled={busy} onClick={() => void start(character)}><MessageSquarePlus size={14} aria-hidden="true" />{tr('开始对话')}</button>
        </footer>
      </li>)}</ul>}
    <h3>{tf('世界书 {0}', [worldbooks.length])}</h3>
    {library && worldbooks.length === 0 ? <p className="xn-tavern__muted">{tr('世界书是可选的。勾选后，其中标为常驻的条目，以及关键词出现在场景或开场白里的条目，会写进开场设定。')}</p>
      : <ul className="xn-tavern__list">{worldbooks.map(book => <li key={book.id} className="xn-tavern-card">
        <header><label><input type="checkbox" checked={books.includes(book.id)} onChange={event => { const checked = event.currentTarget.checked; setBooks(current => checked ? [...current.filter(item => item !== book.id), book.id] : current.filter(item => item !== book.id)); }} />
          <strong>{book.name}</strong></label><span>{tf('{0} 条，其中常驻 {1} 条', [book.entries, book.constant])}</span></header>
        {book.description && <p>{book.description}</p>}
        <footer><button type="button" className="xn-tavern-button" disabled={busy} onClick={() => void remove('worldbooks', book.id)}>{tr('移除')}</button></footer>
      </li>)}</ul>}
  </section>;
}
