import { readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isLink, realish } from '@xueness/sessions';
import { within } from './composer-roots.ts';
import type { TuiChoice } from './tui-types.ts';

const IGNORED_DIRECTORIES = new Set(['.bzr', '.git', '.hg', '.jj', '.sl', '.svn', 'node_modules']);
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/iu;

/** List matching entries directly beneath the directory portion of an @ token. */
export async function listWorkspacePaths(root: string, token: string, limit = 50): Promise<TuiChoice[]> {
  const trimmed = token.replace(/^@/u, '');
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || isAbsolute(trimmed) || WINDOWS_ABSOLUTE.test(trimmed)) return [];
  const normalized = trimmed.replace(/[\\/]+/gu, '/');
  const components = normalized.split('/');
  if (components.some((part) => part === '..')) return [];
  const slash = normalized.lastIndexOf('/');
  const directoryToken = slash < 0 ? '' : normalized.slice(0, slash + 1);
  const query = slash < 0 ? normalized : normalized.slice(slash + 1);

  const base = realish(root);
  const directory = resolve(base, directoryToken);
  let resolvedDirectory: string;
  try {
    resolvedDirectory = realish(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!within(base, resolvedDirectory) || isLink(directory)) return [];

  let entries;
  try {
    entries = await readdir(resolvedDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const candidates: TuiChoice[] = [];
  for (const entry of entries) {
    const directoryEntry = entry.isDirectory();
    if (!directoryEntry && !entry.isFile()) continue;
    if (directoryEntry && IGNORED_DIRECTORIES.has(entry.name)) continue;
    if (!query.startsWith('.') && entry.name.startsWith('.')) continue;
    if (query && !entry.name.toLowerCase().includes(query.toLowerCase())) continue;

    const fullPath = resolve(resolvedDirectory, entry.name);
    if (isLink(fullPath)) continue;
    let canonical: string;
    try {
      canonical = realish(fullPath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!within(base, canonical)) continue;
    const rel = relative(base, canonical);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    const value = rel.split(sep).join('/') + (directoryEntry ? '/' : '');
    const label = entry.name;
    candidates.push({ id: value, label, value, directory: directoryEntry });
  }

  candidates.sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    const leftPrefix = left.label.toLowerCase().startsWith(query.toLowerCase());
    const rightPrefix = right.label.toLowerCase().startsWith(query.toLowerCase());
    if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
    return left.value.localeCompare(right.value);
  });
  return candidates.slice(0, Math.max(1, Math.floor(limit)));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
