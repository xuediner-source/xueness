/**
 * Thin-line SVG icon set (ZCode-style: stroke currentColor, 1.5-2px, no fill).
 * Sized via `size`; colour inherits from text colour. No dependencies.
 */
import React from "react";

export type IconProps = {
  size?: number;
  className?: string;
  /** aria hidden by default — decorative; label the parent control instead. */
  title?: string;
  strokeWidth?: number;
};

function Svg({
  size = 16,
  className,
  title,
  strokeWidth = 2,
  children,
  viewBox = "0 0 24 24",
}: IconProps & { children: React.ReactNode; viewBox?: string }): React.JSX.Element {
  const titleId = React.useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-labelledby={title ? titleId : undefined}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {children}
    </svg>
  );
}

/** 新建任务：圆角方框内一个加号 */
export function IconNewTask(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M12 8v8M8 12h8" />
    </Svg>
  );
}

/** 搜索放大镜 */
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

/** 设置齿轮 */
export function IconGear(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
    </Svg>
  );
}

/** 斜杠命令 */
export function IconSlash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 5 7 19" />
      <circle cx="12" cy="12" r="9.2" strokeOpacity="0.45" />
    </Svg>
  );
}

/** 附加上下文（回形针） */
export function IconPaperclip(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l7.7-7.7a3.1 3.1 0 0 1 4.4 4.4l-7.7 7.7a1.6 1.6 0 0 1-2.2-2.2l6.9-6.9" />
    </Svg>
  );
}

/** 刷新 */
export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Svg>
  );
}

/** 编辑铅笔 */
export function IconPencil(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </Svg>
  );
}

/** 删除垃圾桶 */
export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

/** 完成对勾 */
export function IconCheck(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={2.2}>
      <path d="m4.5 12.5 5 5L19.5 7" />
    </Svg>
  );
}

/** 失败叉 */
export function IconX(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={2.2}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

/** 运行中（旋转圈） */
export function IconLoader(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Svg>
  );
}

/** 返回箭头 ‹ */
export function IconBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

/** 下拉小箭头（chips 用） */
export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props} size={12}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

/** 发送（纸飞机/上箭头） */
export function IconArrowUp(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={2.2}>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </Svg>
  );
}

/** 图钉（置顶） */
export function IconPin(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 4h6l-1 7 3 3H7l3-3-1-7Z" />
      <path d="M12 14v6" />
    </Svg>
  );
}

/** 文件夹（会话头部） */
export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}

export function IconWorkflow(props: IconProps) {
  return <Svg {...props}><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M6 9v9h9M9 6h9v9" /></Svg>;
}

export function IconModel(props: IconProps) {
  return <Svg {...props}><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4z" /></Svg>;
}

export function IconTerminal(props: IconProps) {
  return <Svg {...props}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></Svg>;
}

export function IconMenu(props: IconProps) {
  return <Svg {...props}><path d="M4 6h16M4 12h16M4 18h16" /></Svg>;
}

/* ---------------------------------------------------------------------------
 * Xueness identity.
 *
 * Quantum superposition X mark: solid line (deterministic state / particle)
 * crossing a dashed line (probability wave / uncollapsed state), meeting at
 * the quantum transition core.
 * Geometry is shared with webapp/public/xueness-mark.svg (the favicon) — keep
 * the two in step when either changes.
 * ------------------------------------------------------------------------- */

export function IconXuenessMark({ size = 20, className, title }: IconProps): React.JSX.Element {
  return (
    <Svg size={size} className={className} title={title} strokeWidth={2}>
      <line x1="5.5" y1="5.5" x2="18.5" y2="18.5" />
      <line x1="18.5" y1="5.5" x2="5.5" y2="18.5" strokeDasharray="0.1 3.8" opacity="0.45" />
      <circle cx="12" cy="12" r="2.4" strokeWidth="1.5" />
    </Svg>
  );
}

/** Mark inside a rounded tile — the app-icon form used at larger sizes. */
export function IconXuenessGlyph({ size = 28, className, title }: IconProps): React.JSX.Element {
  return (
    <Svg size={size} className={className} title={title} strokeWidth={1.8}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="5.4" opacity="0.25" />
      <line x1="6.8" y1="6.8" x2="17.2" y2="17.2" />
      <line x1="17.2" y1="6.8" x2="6.8" y2="17.2" strokeDasharray="0.1 3.4" opacity="0.45" />
      <circle cx="12" cy="12" r="2.2" strokeWidth="1.4" />
    </Svg>
  );
}
