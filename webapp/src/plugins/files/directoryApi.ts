import { get, post } from "../../xuenessBridge";

/** 目录条目：宿主给出绝对路径，客户端不自己拼接路径段。 */
export type DirectoryEntry = {
  name: string;
  path: string;
  /** "directory" | "file"；选择器默认只收到目录，文件树会收到两者。 */
  type?: "directory" | "file";
  hidden: boolean;
  isSymbolicLink?: boolean;
};

/** 一个目录层级 + 祖先链。 */
export type DirectoryListing = {
  path: string;
  home: string;
  crumbs: DirectoryEntry[];
  entries: DirectoryEntry[];
  truncated: boolean;
};

/** GET /api/system —— 宿主账号的 home，作为选择器的起始锚点。 */
export async function getSystemHome(): Promise<{ homedir: string }> {
  return get<{ homedir: string }>("/api/system");
}

/**
 * GET /api/directory —— 列出目录层级。
 *
 * `includeFiles` 默认关：目录选择器只走目录（对齐 DSH 的 browse 语义）。
 * 工作区文件树需要文件和目录并列，显式打开。
 */
export async function listDirectory(
  path?: string,
  includeHidden = false,
  includeFiles = false,
): Promise<DirectoryListing> {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  if (includeHidden) query.set("includeHidden", "1");
  if (includeFiles) query.set("includeFiles", "1");
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return get<DirectoryListing>(`/api/directory${suffix}`);
}

/** POST /api/directory —— 在已有父目录下建一个子目录（非递归）。 */
export async function createDirectory(path: string, name: string): Promise<{ path: string }> {
  return post<{ path: string }>("/api/directory", { path, name });
}
