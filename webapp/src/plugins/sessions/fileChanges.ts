// Journal-derived file changes. The backend has no diff endpoint. These helpers
// project the *recorded* tool calls out of a session journal, so the UI can show
// what the agent tried to change. This is deliberately labelled as
// session-recorded intent, never as a live working-tree diff.

export type FileChange = {
  path: string;
  kind: "write" | "edit";
  ok: boolean;
  old?: string;
  new?: string;
  content?: string;
};

export type FileChangeSet = {
  changes: FileChange[];
  source: "session-journal";
};

/** Per-field cap on any recorded text we surface. Keeps a huge write from
 * blowing up the DOM; the UI labels it as trimmed when it is. */
const CHANGE_TEXT_LIMIT = 4000;

function clip(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > CHANGE_TEXT_LIMIT ? value.slice(0, CHANGE_TEXT_LIMIT) : value;
}

/**
 * Project the recorded write/edit tool calls out of a session journal.
 *
 * This reads *intent from the journal*, not the working tree: nothing here
 * touches disk, so it cannot and must not be presented as a live diff. The
 * returned `source` says so explicitly. Malformed entries are skipped rather
 * than throwing — one bad call must not blank the whole view.
 */
export function deriveFileChanges(journal: unknown): FileChangeSet {
  const changes: FileChange[] = [];
  const root = journal && typeof journal === "object" ? (journal as Record<string, unknown>) : null;
  const messages = Array.isArray(root?.messages) ? (root!.messages as unknown[]) : [];
  const results =
    root?.results && typeof root.results === "object"
      ? (root.results as Record<string, unknown>)
      : {};

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const calls = (message as Record<string, unknown>).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const record = call as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== "object") continue;
      const name = (fn as Record<string, unknown>).name;
      if (name !== "write" && name !== "edit") continue;

      let args: unknown;
      try {
        args = JSON.parse(String((fn as Record<string, unknown>).arguments ?? "{}"));
      } catch {
        continue;
      }
      if (!args || typeof args !== "object") continue;
      const argMap = args as Record<string, unknown>;
      const path = argMap.path;
      if (typeof path !== "string" || !path) continue;

      const callId = typeof record.id === "string" ? record.id : "";
      const result = callId ? results[callId] : undefined;
      const ok = !!result && typeof result === "object" && (result as Record<string, unknown>).ok === true;

      if (name === "write") {
        changes.push({ path, kind: "write", ok, content: clip(argMap.content) });
      } else {
        if (typeof argMap.old !== "string" || typeof argMap.new !== "string") continue;
        changes.push({ path, kind: "edit", ok, old: clip(argMap.old), new: clip(argMap.new) });
      }
    }
  }

  return { changes, source: "session-journal" };
}

/**
 * 把 argv 数组格式化成可读的命令行，用于审批卡片和时间线展示。
 * 含空白、引号或为空的参数加双引号，避免 ["git","commit","-m","fix bug"] 与
 * ["git","commit","-m","fix","bug"] 显示成同一串——Windows 上 "C:\Program Files\…"
 * 这类带空格路径尤其常见。只用于展示，不用于实际执行。
 */
export function formatCommandArgv(argv: readonly unknown[]): string {
  return argv.map((item) => {
    const text = typeof item === "string" ? item : JSON.stringify(item) ?? String(item);
    if (text !== "" && !/[\s"']/.test(text)) return text;
    // 只转义双引号：保留 Windows 路径里的反斜杠原样可读。
    return `"${text.replace(/"/g, '\\"')}"`;
  }).join(" ");
}
