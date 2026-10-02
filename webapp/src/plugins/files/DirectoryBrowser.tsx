import React, { useState } from "react";
import { t as tr } from "../../i18n";
import { Badge, Button, EmptyState, Panel, Spinner } from "../../ui/primitives";

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// ============================================================================
// 1. DirectoryBrowser
// ============================================================================

export type DirectoryBrowserProps = {
  /** 当前目录绝对路径，未选为 null */
  currentPath: string | null;
  entries: { name: string; path: string; isDir: boolean; size: number }[];
  error?: string;
  truncated?: boolean;
  loading?: boolean;
  onNavigate?: (path: string) => void;     // 进入子目录 / 上级
  onOpenFile?: (path: string) => void;     // 选中文件
  onCreateDir?: (name: string) => void;    // 新建文件夹
};

export function DirectoryBrowser({
  currentPath,
  entries,
  error,
  truncated = false,
  loading = false,
  onNavigate,
  onOpenFile,
  onCreateDir,
}: DirectoryBrowserProps): React.ReactElement {
  const [newDirName, setNewDirName] = useState("");

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newDirName.trim();
    if (trimmed && onCreateDir) {
      onCreateDir(trimmed);
      setNewDirName("");
    }
  };

  // 目录列在前面，然后按文件名排序
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return (
    <Panel
      title={tr("目录浏览")}
      subtitle={currentPath ? currentPath : tr("未选择目录")}
      padding="flush"
      actions={
        onCreateDir ? (
          <form
            onSubmit={handleCreateSubmit}
            data-testid="create-dir-form"
            style={{ display: "flex", gap: "6px", alignItems: "center" }}
          >
            <input
              type="text"
              aria-label={tr("新建文件夹名称")}
              placeholder={tr("新文件夹名称...")}
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              style={{
                fontSize: "12px",
                padding: "3px 6px",
                borderRadius: "4px",
                border: "1px solid var(--border, #d1d5db)",
                background: "var(--bg, #fff)",
                color: "inherit",
              }}
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!newDirName.trim()}
            >{tr("新建文件夹")}</Button>
          </form>
        ) : undefined
      }
    >
      <div data-testid="directory-browser" style={{ padding: "12px" }}>
        {loading && (
          <div data-testid="directory-loading" style={{ padding: "8px 0" }}>
            <Spinner label={tr("加载目录中...")} />
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="directory-error"
            style={{
              padding: "8px 12px",
              marginBottom: "8px",
              borderRadius: "4px",
              color: "var(--error, #b91c1c)",
              background: "rgba(239, 68, 68, 0.1)",
              fontSize: "13px",
            }}
          >{tr("目录读取失败：")}{error}
          </div>
        )}

        {!loading && !error && sortedEntries.length === 0 && (
          <EmptyState title={tr("目录为空")} hint={tr("当前目录下没有文件或子目录")} />
        )}

        {sortedEntries.length > 0 && (
          <ul
            aria-label={tr("目录内容")}
            data-testid="directory-list"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
          >
            {sortedEntries.map((item) => {
              if (item.isDir) {
                return (
                  <li
                    key={item.path}
                    data-testid={`dir-entry-${item.name}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      borderBottom: "1px solid var(--border, #f3f4f6)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Badge tone="info">{tr("目录")}</Badge>
                      {onNavigate ? (
                        <button
                          type="button"
                          data-testid={`dir-navigate-${item.name}`}
                          onClick={() => onNavigate(item.path)}
                          style={{
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            color: "var(--primary, #2563eb)",
                            cursor: "pointer",
                            fontWeight: 600,
                            fontSize: "13px",
                            textAlign: "left",
                            textDecoration: "underline",
                          }}
                        >
                          {item.name}
                        </button>
                      ) : (
                        <span
                          style={{
                            fontSize: "13px",
                            fontWeight: 600,
                            color: "inherit",
                          }}
                        >
                          {item.name}
                        </span>
                      )}
                    </div>
                  </li>
                );
              }

              return (
                <li
                  key={item.path}
                  data-testid={`file-entry-${item.name}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 8px",
                    borderBottom: "1px solid var(--border, #f3f4f6)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Badge tone="neutral">{tr("文件")}</Badge>
                    {onOpenFile ? (
                      <button
                        type="button"
                        data-testid={`file-open-${item.name}`}
                        onClick={() => onOpenFile(item.path)}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          color: "inherit",
                          cursor: "pointer",
                          fontSize: "13px",
                          textAlign: "left",
                        }}
                      >
                        {item.name}
                      </button>
                    ) : (
                      <span style={{ fontSize: "13px" }}>{item.name}</span>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--muted, #6b7280)",
                    }}
                  >
                    {formatSize(item.size)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {truncated && (
          <div
            data-testid="directory-truncated"
            style={{
              marginTop: "8px",
              padding: "6px 10px",
              fontSize: "12px",
              color: "var(--warn, #b45309)",
              background: "rgba(245, 158, 11, 0.1)",
              borderRadius: "4px",
            }}
          >{tr("内容过多，仅显示部分结果")}</div>
        )}
      </div>
    </Panel>
  );
}
