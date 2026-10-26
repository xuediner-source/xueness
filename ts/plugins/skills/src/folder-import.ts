/** User-selected directory uploads. Files become visible only after validation. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDict, PyValueError } from "@xueness/contracts";
import { protectPrivateDirectory, protectPrivateFile, writeAll } from "@xueness/sessions";
import { MAX_SKILL_FILE_BYTES, MAX_SKILLS_PER_ROOT } from "./discover.ts";
import { parseFrontmatter, validateFrontmatter } from "./frontmatter.ts";
import { contained, isLink, lexists, readText, real } from "./paths.ts";

export const FOLDER_IMPORT_LIMITS = { files: 1024, totalBytes: 32 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, chunkBytes: 384 * 1024 };
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT = ".xueness-import.json";
type FileEntry = { path: string; bytes: number };
type Upload = { createdAt: number; roots: string[]; files: FileEntry[] };
const fail = (message: string): never => { throw new PyValueError(message); };

function relativeFile(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) return fail("文件路径无效");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[<>:"\\|?*\x00-\x1f]/u.test(part)
    || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) return fail("文件路径无效");
  return value;
}

function privateDirectory(path: string): void {
  if (isLink(path)) fail("技能目录不能是链接");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  protectPrivateDirectory(path);
}

function base(stateDir: string): string {
  if (isLink(stateDir)) return fail("状态目录不能是链接");
  const root = real(stateDir);
  if (root === null) return fail("状态目录不可用");
  const directory = join(root, "skill-imports");
  privateDirectory(directory);
  return directory;
}

function stage(stateDir: string, token: string): string {
  if (!TOKEN.test(token)) return fail("导入记录无效");
  const directory = join(base(stateDir), token);
  if (isLink(directory) || !existsSync(directory)) return fail("导入记录不存在或已取消");
  return directory;
}

function saveJson(path: string, value: unknown): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { protectPrivateFile(fd); writeAll(fd, Buffer.from(JSON.stringify(value), "utf8")); } finally { closeSync(fd); }
}

function document(directory: string): Upload {
  const path = join(directory, "upload.json");
  if (isLink(path)) return fail("导入记录无效");
  const read = readText(path, 512 * 1024);
  if (read.text === null || read.failure) return fail("导入记录无效");
  const value: unknown = JSON.parse(read.text);
  if (!isDict(value) || !Number.isSafeInteger(value.createdAt) || !Array.isArray(value.roots) || !value.roots.length
    || value.roots.length > MAX_SKILLS_PER_ROOT || !Array.isArray(value.files) || value.files.length > FOLDER_IMPORT_LIMITS.files) return fail("导入记录无效");
  const roots = value.roots.map(root => root === "" ? "" : relativeFile(root));
  const files = value.files.map(raw => {
    if (!isDict(raw) || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || Number(raw.bytes) > FOLDER_IMPORT_LIMITS.fileBytes) return fail("导入记录无效");
    const path = relativeFile(raw.path);
    if (!roots.some(root => !root || path.startsWith(root + "/"))) return fail("导入记录无效");
    return { path, bytes: Number(raw.bytes) };
  });
  if (files.reduce((sum, file) => sum + file.bytes, 0) > FOLDER_IMPORT_LIMITS.totalBytes) return fail("导入记录无效");
  return { createdAt: Number(value.createdAt), roots, files };
}

function unlinked(path: string, directory: string): void {
  if (!contained(path, directory)) fail("导入路径无效");
  for (let cursor = path; ; cursor = dirname(cursor)) {
    if (isLink(cursor)) fail("导入路径不能是链接");
    if (cursor === directory) return;
  }
}

function discard(directory: string, parent: string): void {
  if (isLink(directory) || !contained(resolve(directory), resolve(parent)) || resolve(directory) === resolve(parent)) fail("导入目录无效");
  rmSync(directory, { recursive: true, force: true });
}

export function beginFolderImport(stateDir: string, data: unknown) {
  if (!isDict(data) || Object.keys(data).join(",") !== "files" || !Array.isArray(data.files) || !data.files.length || data.files.length > FOLDER_IMPORT_LIMITS.files) return fail("文件数量无效，最多 1024 个");
  const seen = new Set<string>();
  let total = 0;
  const files: FileEntry[] = data.files.map(raw => {
    if (!isDict(raw) || Object.keys(raw).sort().join(",") !== "bytes,path") return fail("文件信息无效");
    const path = relativeFile(raw.path), folded = path.normalize("NFC").toLowerCase();
    if (seen.has(folded) || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || Number(raw.bytes) > FOLDER_IMPORT_LIMITS.fileBytes) return fail("文件重复或超过大小限制");
    seen.add(folded); total += Number(raw.bytes);
    return { path, bytes: Number(raw.bytes) };
  });
  if (total > FOLDER_IMPORT_LIMITS.totalBytes) return fail("所选文件夹超过 32 MiB");
  const common = files.every(file => file.path.startsWith(files[0]!.path.split("/")[0]! + "/")) ? files[0]!.path.split("/")[0]! : "";
  const direct = common ? `${common}/SKILL.md` : "SKILL.md";
  const roots = files.some(file => file.path === direct) ? [common] : files.filter(file => file.path.endsWith("/SKILL.md")
    && file.path.split("/").length === (common ? 3 : 2)).map(file => file.path.slice(0, -9));
  if (!roots.length || roots.length > MAX_SKILLS_PER_ROOT) return fail("请选择包含 SKILL.md 的技能文件夹，或包含多个技能的目录");
  const kept = files.filter(file => roots.some(root => !root || file.path.startsWith(root + "/")));
  if (kept.some(file => file.path.split("/").at(-1)?.toLowerCase() === RECEIPT)) return fail("技能包含保留文件名");
  const parent = base(stateDir);
  for (const name of readdirSync(parent)) {
    if (!TOKEN.test(name)) continue;
    const old = join(parent, name);
    if (!isLink(old) && Date.now() - statSync(old).mtimeMs > 24 * 60 * 60 * 1000) discard(old, parent);
  }
  const token = randomUUID(), directory = join(parent, token);
  privateDirectory(directory); privateDirectory(join(directory, "files"));
  saveJson(join(directory, "upload.json"), { createdAt: Date.now(), roots, files: kept });
  return { token, files: kept.map(file => file.path), limits: FOLDER_IMPORT_LIMITS };
}

export function writeFolderChunk(stateDir: string, token: string, data: unknown) {
  const directory = stage(stateDir, token), upload = document(directory);
  if (!isDict(data) || Object.keys(data).sort().join(",") !== "content,offset,path" || !Number.isSafeInteger(data.offset) || Number(data.offset) < 0) return fail("文件块信息无效");
  const path = relativeFile(data.path), entry = upload.files.find(file => file.path === path);
  if (!entry || typeof data.content !== "string" || data.content.length > FOLDER_IMPORT_LIMITS.chunkBytes * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data.content)) return fail("文件块无效");
  const raw = Buffer.from(data.content, "base64"), target = join(directory, "files", ...path.split("/"));
  const parent = dirname(target);
  unlinked(target, directory);
  privateDirectory(parent);
  if (isLink(target)) return fail("导入路径不能是链接");
  const current = existsSync(target) ? statSync(target).size : 0;
  if (data.offset !== current || current + raw.length > entry.bytes) return fail("文件内容位置不匹配");
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fstatSync(fd).isFile()) return fail("导入对象必须是文件");
    protectPrivateFile(fd); writeAll(fd, raw);
  } finally { closeSync(fd); }
  return { written: current + raw.length };
}

export function commitFolderImport(stateDir: string, token: string) {
  const directory = stage(stateDir, token), upload = document(directory);
  for (const file of upload.files) {
    const path = join(directory, "files", ...file.path.split("/"));
    unlinked(path, directory);
    if (isLink(path) || !existsSync(path) || statSync(path).size !== file.bytes) return fail("文件尚未上传完成");
  }
  const targetRoot = join(real(stateDir)!, "skills"); privateDirectory(targetRoot);
  const names = new Set<string>();
  const moves = upload.roots.map(root => {
    const from = join(directory, "files", root), path = join(from, "SKILL.md"), read = readText(path, MAX_SKILL_FILE_BYTES);
    if (read.text === null || read.failure) return fail("SKILL.md 不可读、过大或不是 UTF-8 文本");
    const parsed = parseFrontmatter(read.text), checked = validateFrontmatter(parsed.values, parsed.keys, path);
    if (parsed.error || !checked.meta) return fail("SKILL.md 需要有效的 name 与 description");
    const name = checked.meta.name, to = join(targetRoot, name);
    if (names.has(name.toLowerCase()) || lexists(to)) return fail(`技能已存在：${name}，请更换名称后重试`);
    names.add(name.toLowerCase());
    return { from, to, name, description: checked.meta.description };
  });
  const completed: typeof moves = [];
  try {
    for (const move of moves) { saveJson(join(move.from, RECEIPT), { token, name: move.name }); renameSync(move.from, move.to); completed.push(move); }
  } catch (error) {
    for (const move of completed.reverse()) renameSync(move.to, move.from);
    throw error;
  }
  discard(directory, base(stateDir));
  return { imported: moves.map(move => ({ name: move.name, description: move.description })), files: upload.files.length };
}

export function cancelFolderImport(stateDir: string, token: string) {
  const directory = stage(stateDir, token); discard(directory, base(stateDir)); return { cancelled: true };
}

export function importedSkillFolder(stateDir: string, name: string): boolean {
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return false;
  const root = join(stateDir, "skills"), directory = join(root, name), receipt = join(directory, RECEIPT);
  if (isLink(stateDir) || isLink(root) || isLink(directory) || isLink(receipt)) return false;
  try { const read = readText(receipt, 256); const value = JSON.parse(read.text ?? ""); return value.name === name && TOKEN.test(value.token); } catch { return false; }
}

export function removeImportedSkill(stateDir: string, name: string) {
  if (!importedSkillFolder(stateDir, name)) return fail("只能移除通过文件夹添加的技能");
  const root = join(stateDir, "skills"); discard(join(root, name), root); return { removed: name };
}
