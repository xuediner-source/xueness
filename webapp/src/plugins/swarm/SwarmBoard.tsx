import React, { useEffect, useMemo, useRef, useState } from "react";
import { t as tr, tf } from "../../i18n";
import { postToBoard, type BoardPost, type SwarmChannel } from "./swarmApi";

const KIND_LABELS: Partial<Record<BoardPost["kind"], string>> = { verdict: "验证结论", done: "完成", system: "系统" };

export function senderLabel(post: Pick<BoardPost, "from" | "kind">): string {
  if (post.kind === "user" || post.from === "user") return tr("你");
  if (post.kind === "system" || post.from === "system") return tr("系统");
  return `@${post.from}`;
}

export function addressees(post: BoardPost): string[] {
  const { to } = post;
  const list = [...(to?.all ? ["@all"] : []), ...(to?.groups ?? []).map(group => `@${group}`), ...(to?.channels ?? []).map(chan => `@#${chan}`), ...(to?.names ?? []).map(name => `@${name}`)];
  return list.length > 0 ? list : post.recipients.map(name => `@${name}`);
}

export function formatTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderRichText(text: string, onCite: (seq: number) => void): React.ReactNode {
  const tokens = text.split(/(#[1-9]\d*|@#[a-z][a-z0-9-]{0,23}|@[a-z][a-z0-9-]{0,23})/gi);
  return tokens.map((part, idx) => {
    if (/^#[1-9]\d*$/.test(part)) {
      const seq = Number(part.slice(1));
      return <button key={idx} type="button" className="xn-swarm-cite" onClick={() => onCite(seq)}>{part}</button>;
    }
    if (/^@#[a-z][a-z0-9-]{0,23}$/i.test(part) || /^@[a-z][a-z0-9-]{0,23}$/i.test(part)) {
      return <span key={idx} className="xn-swarm-mention">{part}</span>;
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

type Props = { sessionId: string; swarmId: string; posts: BoardPost[]; channels?: SwarmChannel[]; focusSeq?: { seq: number; n: number } | null; canPost: boolean; onPosted: () => void };

export function SwarmBoard({ sessionId, swarmId, posts, channels = [], focusSeq, canPost, onPosted }: Props): React.JSX.Element {
  const [text, setText] = useState("");
  const [recipients, setRecipients] = useState("");
  const [postChannel, setPostChannel] = useState("main");
  const [query, setQuery] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLOListElement | null>(null);

  const channelNames = useMemo(() => {
    const names = new Set(["main", ...channels.map(c => c.name), ...posts.map(p => p.channel || "main")]);
    return [...names];
  }, [channels, posts]);
  const senders = useMemo(() => [...new Set(posts.map(p => p.from))], [posts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return posts.filter(p => {
      if (fromFilter && p.from !== fromFilter) return false;
      if (channelFilter && (p.channel ?? "main") !== channelFilter) return false;
      if (q && !p.text.toLowerCase().includes(q) && !String(p.seq).includes(q.replace(/^#/, "")) && !p.from.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [posts, query, fromFilter, channelFilter]);

  const jumpToSeq = (seq: number) => {
    setQuery(""); setFromFilter(""); setChannelFilter("");
    setFollow(false);
    setHighlighted(seq);
    window.requestAnimationFrame(() => {
      listRef.current?.querySelector(`#swarm-post-${seq}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    window.setTimeout(() => setHighlighted(cur => (cur === seq ? null : cur)), 2400);
  };

  useEffect(() => { if (focusSeq) jumpToSeq(focusSeq.seq); }, [focusSeq]);

  useEffect(() => {
    const list = listRef.current;
    if (list && follow) list.scrollTop = list.scrollHeight;
  }, [filtered.length, follow]);

  const send = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      const names = recipients.split(/[,，\s]+/u).map(name => name.replace(/^@/u, "").trim()).filter(Boolean);
      await postToBoard(sessionId, swarmId, body, names, postChannel);
      setText("");
      onPosted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return <div className="xn-swarm-board" data-testid="swarm-board">
    {posts.length > 0 && <div className="xn-swarm-board__filters">
      <input type="search" value={query} placeholder={tr("搜索帖子或 #编号…")} aria-label={tr("搜索帖子或 #编号…")} onChange={e => setQuery(e.currentTarget.value)} />
      <select aria-label={tr("按发送者筛选")} value={fromFilter} onChange={e => setFromFilter(e.currentTarget.value)}>
        <option value="">{tr("全部发送者")}</option>
        {senders.map(s => <option key={s} value={s}>{s === "user" ? tr("你") : s === "system" ? tr("系统") : `@${s}`}</option>)}
      </select>
      {channelNames.length > 1 && <select aria-label={tr("按频道筛选")} value={channelFilter} onChange={e => setChannelFilter(e.currentTarget.value)}>
        <option value="">{tr("全部频道")}</option>
        {channelNames.map(c => <option key={c} value={c}>#{c}</option>)}
      </select>}
      <button type="button" aria-pressed={follow} onClick={() => { setFollow(v => !v); if (!follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }}>
        {follow ? tr("跟随最新：开") : tr("回到最新")}
      </button>
    </div>}
    {posts.length === 0 ? <p className="xn-swarm-muted">{tr("看板上还没有发言。")}</p>
      : filtered.length === 0 ? <p className="xn-swarm-muted">{tr("没有符合筛选条件的帖子。")}</p>
      : <ol className="xn-swarm-board__list" ref={listRef} aria-label={tr("共享看板")}
        onScroll={event => { const list = event.currentTarget; const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40; if (!nearEnd && follow) setFollow(false); }}>
        {filtered.map(post => <li key={post.seq} id={`swarm-post-${post.seq}`} className="xn-swarm-post" data-kind={post.kind} data-highlighted={highlighted === post.seq ? "true" : undefined}>
          <div className="xn-swarm-post__head">
            <span className="xn-swarm-post__seq">#{post.seq}</span>
            <strong>{senderLabel(post)}</strong>
            {post.channel && post.channel !== "main" && <span className="xn-swarm-chip">#{post.channel}</span>}
            {addressees(post).length > 0 && <span className="xn-swarm-post__to">{tf("发给 {0}", [addressees(post).join(" ")])}</span>}
            {KIND_LABELS[post.kind] && <span className="xn-swarm-chip" data-tone={post.kind}>{tr(KIND_LABELS[post.kind]!)}</span>}
            <time dateTime={post.at}>{formatTime(post.at)}</time>
          </div>
          <p className="xn-swarm-post__text">{renderRichText(post.text, jumpToSeq)}</p>
        </li>)}
      </ol>}
    <form className="xn-swarm-composer" onSubmit={event => void send(event)}>
      {error && <p className="xn-swarm-error" role="alert">{error}</p>}
      <div className="xn-swarm-composer__row">
        <label className="xn-swarm-composer__to"><span>{tr("发送给")}</span>
          <input type="text" value={recipients} disabled={!canPost || sending} placeholder={tr("留空则发给协调者；支持正文内写 @成员/@#频道/#编号")}
            onChange={event => setRecipients(event.currentTarget.value)} autoComplete="off" /></label>
        <label className="xn-swarm-composer__chan"><span>{tr("频道")}</span>
          <input type="text" value={postChannel} list="swarm-channel-options" disabled={!canPost || sending} maxLength={24}
            onChange={event => setPostChannel(event.currentTarget.value)} /></label>
        <datalist id="swarm-channel-options">{channelNames.map(c => <option key={c} value={c} />)}</datalist>
      </div>
      <textarea value={text} rows={3} maxLength={4000} disabled={!canPost || sending} aria-label={tr("发言内容")}
        placeholder={canPost ? tr("向蜂群发言…") : tr("蜂群已结束，不能再发言。")}
        onChange={event => setText(event.currentTarget.value)} />
      <button type="submit" disabled={!canPost || sending || !text.trim()}>{sending ? tr("正在发送…") : tr("发送")}</button>
    </form>
  </div>;
}

export default SwarmBoard;
