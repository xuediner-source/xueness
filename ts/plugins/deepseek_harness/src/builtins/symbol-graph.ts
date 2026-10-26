/**
 * Compact TypeScript/Python symbol graph for DeepSeek context windows (H02.04).
 *
 * Pure string analysis: extracts a deterministic set of named symbols
 * (functions, classes, methods, exports) and directed references between
 * them. No AST parser dependency — regex-based extractors tuned for the
 * shapes DeepSeek already sees in repo maps.
 */

export type SymbolLanguage = "typescript" | "python" | "unknown";

export interface SymbolNode {
  id: string;
  name: string;
  kind: "function" | "class" | "method" | "export" | "const";
  language: SymbolLanguage;
  line: number;
}

export interface SymbolEdge {
  from: string;
  to: string;
  kind: "calls" | "extends" | "references";
}

export interface SymbolGraph {
  file: string;
  language: SymbolLanguage;
  nodes: readonly SymbolNode[];
  edges: readonly SymbolEdge[];
}

export function detectLanguage(path: string): SymbolLanguage {
  if (/\.(ts|tsx|mts|cts|js|jsx)$/i.test(path)) return "typescript";
  if (/\.py$/i.test(path)) return "python";
  return "unknown";
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

const TS_DECL =
  /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?class\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)|^\s*(?:public|private|protected|static|async\s+)*(\w+)\s*\([^;]*\)\s*\{)/gm;

const PY_DECL = /^(?:async\s+)?def\s+(\w+)\s*\(|^class\s+(\w+)\s*[\(:]/gm;

/** Build a symbol graph for one source file. Deterministic node/edge order. */
export function buildSymbolGraph(file: string, source: string): SymbolGraph {
  const language = detectLanguage(file);
  const nodes: SymbolNode[] = [];
  const seen = new Set<string>();
  const push = (name: string, kind: SymbolNode["kind"], index: number): void => {
    const id = `${file}#${name}`;
    if (seen.has(id)) return;
    seen.add(id);
    nodes.push({ id, name, kind, language, line: lineOf(source, index) });
  };

  if (language === "typescript") {
    let match: RegExpExecArray | null;
    const re = new RegExp(TS_DECL.source, TS_DECL.flags);
    while ((match = re.exec(source)) !== null) {
      if (match[1]) push(match[1], "function", match.index);
      else if (match[2]) push(match[2], "class", match.index);
      else if (match[3]) push(match[3], "const", match.index);
      else if (match[4] && !["if", "for", "while", "switch", "catch", "function"].includes(match[4])) {
        push(match[4], "method", match.index);
      }
    }
  } else if (language === "python") {
    let match: RegExpExecArray | null;
    const re = new RegExp(PY_DECL.source, PY_DECL.flags);
    while ((match = re.exec(source)) !== null) {
      if (match[1]) push(match[1], "function", match.index);
      else if (match[2]) push(match[2], "class", match.index);
    }
  }

  nodes.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

  const edges: SymbolEdge[] = [];
  const names = new Set(nodes.map((node) => node.name));
  for (const node of nodes) {
    for (const other of names) {
      if (other === node.name) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(other)}\\s*\\(`, "g");
      // Only scan the body-ish region after the declaration line for calls.
      const from = source.split(/\r?\n/).slice(node.line).join("\n");
      if (pattern.test(from)) edges.push({ from: node.id, to: `${file}#${other}`, kind: "calls" });
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return { file, language, nodes, edges };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Look up a symbol by unqualified name (first match) or full id. */
export function findSymbol(graph: SymbolGraph, nameOrId: string): SymbolNode | null {
  return graph.nodes.find((node) => node.id === nameOrId || node.name === nameOrId) ?? null;
}
