/**
 * Compact repo-map builder tailored for DeepSeek context windows (H02.03).
 *
 * Turns a list of path+source pairs into a bounded, deterministic map:
 * ranked files, per-file symbol summaries from `symbol-graph`, and a
 * character budget that prefers high-signal declarations over bodies.
 */
import { buildSymbolGraph, type SymbolGraph, type SymbolLanguage } from "./symbol-graph.ts";

export interface RepoMapFileInput {
  path: string;
  source: string;
  /** Optional weight; higher stays when the budget is tight. Default 1. */
  weight?: number;
}

export interface RepoMapFileSummary {
  path: string;
  language: SymbolLanguage;
  symbols: readonly string[];
  edges: number;
  chars: number;
}

export interface RepoMap {
  files: readonly RepoMapFileSummary[];
  totalSymbols: number;
  totalChars: number;
  truncated: boolean;
  /** Rendered compact text for a prompt prefix. */
  text: string;
}

export interface RepoMapOptions {
  /** Soft character budget for `text`. Default 6000. */
  budget?: number;
  /** Max symbols listed per file. Default 24. */
  maxSymbolsPerFile?: number;
}

/** Build a compact repo map. Equal inputs always produce equal output. */
export function buildRepoMap(files: readonly RepoMapFileInput[], options: RepoMapOptions = {}): RepoMap {
  const budget = Math.max(64, options.budget ?? 6000);
  const maxSymbols = Math.max(1, options.maxSymbolsPerFile ?? 24);
  const ranked = [...files]
    .map((file) => ({ ...file, weight: file.weight ?? 1, graph: buildSymbolGraph(file.path, file.source) }))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));

  const summaries: RepoMapFileSummary[] = [];
  const lines: string[] = [];
  let totalChars = 0;
  let totalSymbols = 0;
  let truncated = false;

  for (const entry of ranked) {
    const symbols = entry.graph.nodes.slice(0, maxSymbols).map((node) => `${node.kind}:${node.name}@${node.line}`);
    const header = `# ${entry.path} [${entry.graph.language}]`;
    const body = symbols.length ? symbols.map((symbol) => `  - ${symbol}`).join("\n") : "  - (no symbols)";
    const block = `${header}\n${body}`;
    if (totalChars + block.length + 1 > budget && summaries.length > 0) {
      truncated = true;
      break;
    }
    summaries.push({
      path: entry.path,
      language: entry.graph.language,
      symbols,
      edges: entry.graph.edges.length,
      chars: block.length,
    });
    lines.push(block);
    totalChars += block.length + 1;
    totalSymbols += symbols.length;
    if (entry.graph.nodes.length > maxSymbols) truncated = true;
  }

  const text = lines.join("\n");
  return { files: summaries, totalSymbols, totalChars: text.length, truncated, text };
}

/** Convenience: graph one file then summarize it like repo-map would. */
export function summarizeFile(path: string, source: string): RepoMapFileSummary {
  const map = buildRepoMap([{ path, source }], { budget: 100_000, maxSymbolsPerFile: 100 });
  return map.files[0]!;
}

export type { SymbolGraph };
