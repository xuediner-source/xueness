/**
 * Markdown parsing for transcript prose (react-markdown + GFM). This module and
 * its parser stay out of the startup bundle: `SimpleMarkdown` in XuenessShell
 * loads it right after the first paint and renders plain text until it is ready.
 */
import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, X } from "lucide-react";
import { t as tr } from "../../i18n";
import { CodeContent } from "../../ui/CodeContent";
import type { CodeLanguage } from "../../ui/CodePreview";
import { prepareStreamingMarkdown } from "../../ui/StreamingCommitGate";
import { copyTextToClipboard, MarkdownRenderOptionsContext } from "../../XuenessShell";

function CopyFeedbackAction({
  text,
  testId,
  label,
}: {
  text: string;
  testId: string;
  label: string;
}): React.JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const copy = async () => {
    const copied = await copyTextToClipboard(text);
    if (!mountedRef.current) return;
    setState(copied ? "copied" : "failed");
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (mountedRef.current) setState("idle");
    }, copied ? 1200 : 2400);
  };

  return (
    <span className="xn-msg__copy-action">
      <button
        type="button"
        className="xn-msg__copy-button"
        aria-label={label}
        title={label}
        data-testid={testId}
        disabled={text.length === 0}
        onClick={() => void copy()}
      >
        {state === "copied" ? <Check size={14} aria-hidden="true" /> : state === "failed" ? <X size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <span className={`xn-msg__copy-feedback${state === "failed" ? " xn-msg__copy-feedback--error" : ""}`} role="status" aria-live="polite">
        {state === "copied" ? tr("已复制") : state === "failed" ? tr("复制失败") : ""}
      </span>
    </span>
  );
}

const MARKDOWN_CODE_LANGUAGES: Record<string, CodeLanguage> = {
  bash: "bash", sh: "bash", shell: "bash", zsh: "bash",
  c: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
  css: "css", diff: "diff", patch: "diff", go: "go", golang: "go",
  html: "html", xml: "html", js: "javascript", javascript: "javascript", mjs: "javascript",
  jsx: "jsx", json: "json", md: "markdown", markdown: "markdown",
  py: "python", python: "python", rs: "rust", rust: "rust", sql: "sql",
  ts: "typescript", typescript: "typescript", tsx: "tsx", yml: "yaml", yaml: "yaml",
};

function markdownCodeLanguage(info?: string): CodeLanguage | "text" {
  const language = info?.trim().split(/\s+/u)[0]?.toLowerCase().replace(/^\./u, "");
  return language ? MARKDOWN_CODE_LANGUAGES[language] ?? "text" : "text";
}

function markdownNodeText(value: React.ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(markdownNodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(value)) return markdownNodeText(value.props.children);
  return "";
}

function MarkdownCodeFence({
  text,
  info,
}: {
  text: string;
  info?: string;
}): React.JSX.Element {
  const options = React.useContext(MarkdownRenderOptionsContext);
  const language = markdownCodeLanguage(info);
  const languageLabel = info?.trim().split(/\s+/u)[0] || tr("纯文本");
  const testId = `xn-copy-code-${React.useId()}`;
  return (
    <div className="xn-md__code-fence" data-language={language} data-highlight={options.codeHighlightTiming}>
      <header className="xn-md__code-header">
        <span>{languageLabel}</span>
        <CopyFeedbackAction text={text} testId={testId} label={tr("复制代码")} />
      </header>
      <CodeContent text={text} language={language} highlightTiming={options.codeHighlightTiming} />
    </div>
  );
}

function safeMarkdownUrl(url: string): string {
  const safe = defaultUrlTransform(url);
  // Keep the library's conservative protocol allowlist explicit at our render boundary.
  if (!safe || /^(?:javascript|data|vbscript):/iu.test(safe.trim())) return "";
  return safe;
}

const markdownComponents: Components = {
  h1: ({ node: _node, children, ...props }) => <h1 className="xn-md__heading xn-md__heading--1" {...props}>{children}</h1>,
  h2: ({ node: _node, children, ...props }) => <h2 className="xn-md__heading xn-md__heading--2" {...props}>{children}</h2>,
  h3: ({ node: _node, children, ...props }) => <h3 className="xn-md__heading xn-md__heading--3" {...props}>{children}</h3>,
  h4: ({ node: _node, children, ...props }) => <h4 className="xn-md__heading xn-md__heading--4" {...props}>{children}</h4>,
  h5: ({ node: _node, children, ...props }) => <h5 className="xn-md__heading xn-md__heading--5" {...props}>{children}</h5>,
  h6: ({ node: _node, children, ...props }) => <h6 className="xn-md__heading xn-md__heading--6" {...props}>{children}</h6>,
  p: ({ node: _node, children, ...props }) => <p className="xn-md__paragraph" {...props}>{children}</p>,
  ul: ({ node: _node, children, className, ...props }) => <ul className={`xn-md__list xn-md__list--unordered ${className ?? ""}`.trim()} {...props}>{children}</ul>,
  ol: ({ node: _node, children, className, ...props }) => <ol className={`xn-md__list xn-md__list--ordered ${className ?? ""}`.trim()} {...props}>{children}</ol>,
  li: ({ node: _node, children, className, ...props }) => <li className={`xn-md__list-item ${className ?? ""}`.trim()} {...props}>{children}</li>,
  blockquote: ({ node: _node, children, ...props }) => <blockquote className="xn-md__blockquote" {...props}>{children}</blockquote>,
  table: ({ node: _node, children, ...props }) => <div className="xn-md__table-wrap"><table className="xn-md__table" {...props}>{children}</table></div>,
  thead: ({ node: _node, children, ...props }) => <thead {...props}>{children}</thead>,
  tbody: ({ node: _node, children, ...props }) => <tbody {...props}>{children}</tbody>,
  tr: ({ node: _node, children, ...props }) => <tr {...props}>{children}</tr>,
  th: ({ node: _node, children, ...props }) => <th className="xn-md__table-cell xn-md__table-cell--head" {...props}>{children}</th>,
  td: ({ node: _node, children, ...props }) => <td className="xn-md__table-cell" {...props}>{children}</td>,
  a: ({ node: _node, href, children, ...props }) => {
    const safeHref = href ? safeMarkdownUrl(href) : "";
    if (!safeHref) return <span>{children}</span>;
    const external = /^https?:\/\//iu.test(safeHref);
    return <a href={safeHref} {...props} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
  },
  img: ({ node: _node, src, alt, ...props }) => {
    const safeSrc = src ? safeMarkdownUrl(src) : "";
    return safeSrc ? <img src={safeSrc} alt={alt ?? ""} loading="lazy" className="xn-md__image" {...props} /> : null;
  },
  code: ({ node: _node, children, className, ...props }) => <code className={`xn-md__inline-code ${className ?? ""}`.trim()} {...props}>{children}</code>,
  strong: ({ node: _node, children, ...props }) => <strong className="xn-md__bold" {...props}>{children}</strong>,
  em: ({ node: _node, children, ...props }) => <em className="xn-md__italic" {...props}>{children}</em>,
  del: ({ node: _node, children, ...props }) => <del className="xn-md__strike" {...props}>{children}</del>,
  pre: ({ node: _node, children, ...props }) => {
    const child = React.Children.toArray(children)[0];
    if (React.isValidElement<{ children?: React.ReactNode; className?: string }>(child)) {
      const code = child.props;
      return <MarkdownCodeFence text={markdownNodeText(code.children).replace(/\n$/u, "")} info={code.className?.match(/language-([^\s]+)/u)?.[1]} />;
    }
    return <pre className="xn-md__code-block" {...props}>{children}</pre>;
  },
};

const REMARK_PLUGINS = [remarkGfm];

/** Entries kept in the content-keyed markdown element cache before the oldest is evicted. */
export const MARKDOWN_ELEMENT_CACHE_LIMIT = 240;
const markdownElementCache = new Map<string, React.JSX.Element>();

/** Streaming text is revealed a few characters per frame; while the reveal
 * is inside a withheld row or marker the prepared source is unchanged, so a
 * few recent trees are reused instead of parsing the same source again. */
const streamingElementCache = new Map<string, React.JSX.Element>();
const streamingRawCache = new Map<string, React.JSX.Element>();
const STREAMING_ELEMENT_CACHE_LIMIT = 8;

function renderMarkdownElements(text: string, streaming = false): React.JSX.Element {
  const rawHit = streaming ? streamingRawCache.get(text) : undefined;
  if (rawHit) return rawHit;
  const source = streaming ? prepareStreamingMarkdown(text) : text;
  const reused = streaming ? streamingElementCache.get(source) : undefined;
  const elements = reused ?? ReactMarkdown({
    children: source,
    remarkPlugins: REMARK_PLUGINS,
    components: markdownComponents,
    skipHtml: true,
    urlTransform: safeMarkdownUrl,
  });
  if (streaming) {
    streamingRawCache.set(text, elements);
    if (streamingRawCache.size > STREAMING_ELEMENT_CACHE_LIMIT) streamingRawCache.delete(streamingRawCache.keys().next().value!);
    streamingElementCache.set(source, elements);
    if (streamingElementCache.size > STREAMING_ELEMENT_CACHE_LIMIT) {
      const oldest = streamingElementCache.keys().next().value;
      if (oldest !== undefined) streamingElementCache.delete(oldest);
    }
  }
  return elements;
}

/**
 * ReactMarkdown element tree for `text`, memoized by exact content: identical
 * markdown (virtual-window remounts, session switches, repeated renders of
 * unchanged history) parses and compiles once. `ReactMarkdown` is a pure
 * function without hooks (react-markdown v10 `Markdown`), so calling it
 * directly here yields the same element tree the JSX path would render.
 * With `cacheResults=false` the tree is rendered fresh and the cache is left
 * untouched (used for still-growing streaming text).
 */
export function cachedMarkdownElements(text: string, cacheResults = true, streaming = false): React.JSX.Element {
  if (!cacheResults) return renderMarkdownElements(text, streaming);
  // Streaming and settled parses of identical source have intentionally
  // different syntax trees (tables/links are deferred while streaming).
  const cacheKey = streaming ? `\u0000streaming:${text}` : text;
  const cached = markdownElementCache.get(cacheKey);
  if (cached) {
    // Re-insert so Map insertion order keeps this entry as most-recently used.
    markdownElementCache.delete(cacheKey);
    markdownElementCache.set(cacheKey, cached);
    return cached;
  }
  const elements = renderMarkdownElements(text, streaming);
  markdownElementCache.set(cacheKey, elements);
  if (markdownElementCache.size > MARKDOWN_ELEMENT_CACHE_LIMIT) {
    const oldest = markdownElementCache.keys().next().value;
    if (oldest !== undefined) markdownElementCache.delete(oldest);
  }
  return elements;
}
