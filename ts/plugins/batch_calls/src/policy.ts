/** Stable, bilingual host guidance. Keep this static so request prefixes stay reusable. */
export const BATCH_CALLS_POLICY = [
  "## 批量调用",
  "对互不依赖的侦查操作（例如读取、搜索和列出目录），尽量在同一步发出多个独立工具调用，通常建议 3–6 个。只有后续调用依赖前一步结果时才分步；同一文件的先读后写和连续写入必须串行。",
  "破坏性操作和需要审批的操作必须遵守原有 Gate 与审批流程，不得通过合并或拆分调用绕过它们。执行上下文压缩时，在 checkpoint 的 Critical Context 中保留本规则。",
  "",
  "## Batch calls",
  "For independent inspection tasks such as reading, searching, or listing files, issue multiple independent tool calls in the same assistant step when useful; typically aim for 3–6. Split only when a later call depends on an earlier result. Keep read-then-write and repeated writes to the same file sequential.",
  "Destructive actions and actions requiring approval must follow the existing Gate and approval flow; never bypass them by grouping or splitting calls. When context is compacted, preserve this rule in the checkpoint's Critical Context.",
].join("\n");

export const BATCH_CALLS_COMPACTION_REMINDER = [
  "上下文刚完成压缩：批量调用规则仍有效；本步把互不依赖的侦查调用一起发出，依赖调用、同文件读写和需要审批的操作继续按原流程执行。",
  "Context was just compacted: batch independent inspection calls in this step; keep dependent calls, same-file reads and writes, and gated actions on their existing sequence.",
].join("\n");
