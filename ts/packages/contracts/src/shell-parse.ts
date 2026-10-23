/**
 * A deliberately small POSIX shell parser for permission decisions.
 *
 * It splits a command line into simple commands (words, leading assignments,
 * redirections) and records every construct whose effect cannot be known
 * without running the shell: expansions, command and process substitution,
 * here-documents, brace expansion, control flow, function definitions,
 * unterminated quotes. The policy only auto-allows a command when that list
 * is empty, so the parser may be incomplete, but never optimistic. Words that
 * a glob or `~` can turn into other words are flagged: `rg x *` runs
 * `rg x --pre=bash …` in a directory with a file named `--pre=bash`. The
 * text of substitutions is kept so deny rules can look inside them. It never
 * throws.
 */

export interface Redirect {
  op: string;
  fd: number | null;
  /** Target word after quote removal; null when the line ended first. */
  target: string | null;
}

export interface SimpleCommand {
  assignments: string[];
  words: string[];
  /** Per word: a glob the shell may turn into option-like words (`*`, `-*`), or a `~` it turns into a home path. */
  expands: boolean[];
  redirects: Redirect[];
}

export interface ParsedShell {
  commands: SimpleCommand[];
  /** Source text of `$(…)`, backtick and `<(…)` substitutions, for deny rules. */
  substitutions: string[];
  /** Why the line cannot be judged statically; empty when it can. */
  unsafe: string[];
}

type Token =
  | { kind: "word"; text: string; raw: string; expands: boolean }
  | { kind: "op"; op: string }
  | { kind: "redirect"; op: string; fd: number | null };

const RESERVED_SEPARATORS = new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "for", "case", "esac", "select", "function", "coproc", "[[", "]]"]);
const GROUPING = new Set(["{", "}", "!", "time"]);
const MAX_DEPTH = 8;

/** Index just past the `)` closing a `(` at `start - 1`, skipping quotes; -1 when unterminated. */
function closeParen(source: string, start: number): number {
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") i += 1;
    else if (char === "'") {
      i = source.indexOf("'", i + 1);
      if (i < 0) return -1;
    } else if (char === '"') {
      for (i += 1; i < source.length && source[i] !== '"'; i += 1) if (source[i] === "\\") i += 1;
      if (i >= source.length) return -1;
    } else if (char === "`") {
      for (i += 1; i < source.length && source[i] !== "`"; i += 1) if (source[i] === "\\") i += 1;
      if (i >= source.length) return -1;
    } else if (char === "(") depth += 1;
    else if (char === ")" && (depth -= 1) === 0) return i + 1;
  }
  return -1;
}

class Lexer {
  readonly tokens: Token[] = [];
  readonly substitutions: string[] = [];
  readonly unsafe = new Set<string>();
  readonly #s: string;
  #i = 0;

  constructor(source: string) {
    this.#s = source;
  }

  run(): void {
    const s = this.#s;
    while (this.#i < s.length) {
      const char = s[this.#i] as string;
      if (char === " " || char === "\t") this.#i += 1;
      else if (char === "\\" && s[this.#i + 1] === "\n") this.#i += 2;
      else if (char === "\n" || char === "\r") {
        this.tokens.push({ kind: "op", op: ";" });
        this.#i += 1;
      } else if (char === "#") {
        while (this.#i < s.length && s[this.#i] !== "\n") this.#i += 1;
      } else if (!this.#operator()) this.#word();
    }
  }

  #operator(): boolean {
    const s = this.#s;
    const rest = s.slice(this.#i, this.#i + 3);
    const fdMatch = /^(\d+)(?=[<>])/.exec(s.slice(this.#i, this.#i + 12));
    const at = fdMatch ? this.#i + (fdMatch[1] as string).length : this.#i;
    const tail = s.slice(at, at + 3);
    if ((tail[0] === "<" || tail[0] === ">") && tail[1] === "(" && !fdMatch) {
      const end = closeParen(s, at + 2);
      this.unsafe.add("process substitution");
      this.substitutions.push(end < 0 ? s.slice(at + 2) : s.slice(at + 2, end - 1));
      this.tokens.push({ kind: "word", text: "", raw: "", expands: false });
      this.#i = end < 0 ? s.length : end;
      return true;
    }
    const redirect = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(tail)?.[0] ?? (!fdMatch ? /^&>>?/.exec(rest)?.[0] : undefined);
    if (redirect) {
      if (redirect.startsWith("<<") && redirect !== "<<<") this.unsafe.add("here-document");
      this.tokens.push({ kind: "redirect", op: redirect, fd: fdMatch ? Number(fdMatch[1]) : null });
      this.#i = at + redirect.length;
      return true;
    }
    if (fdMatch) return false;
    const op = /^(?:&&|\|\||;;|\|&|[;&|()])/.exec(rest)?.[0];
    if (!op) return false;
    if (op === ";;") this.unsafe.add("case statement");
    this.tokens.push({ kind: "op", op: op === ";;" ? ";" : op });
    this.#i += op.length;
    return true;
  }

  #word(): void {
    const s = this.#s;
    const start = this.#i;
    let text = "";
    // The unquoted characters; quoted and escaped ones become NUL, so `'*'` is not a glob.
    let bare = "";
    while (this.#i < s.length) {
      const char = s[this.#i] as string;
      if (" \t\n\r;&|<>()".includes(char)) break;
      bare += char === "\\" || char === "'" || char === '"' || char === "$" || char === "`" ? "\0" : char;
      if (char === "\\") {
        if (s[this.#i + 1] !== "\n") text += s[this.#i + 1] ?? "";
        this.#i += 2;
      } else if (char === "'") {
        const end = s.indexOf("'", this.#i + 1);
        if (end < 0) {
          this.unsafe.add("unterminated quote");
          text += s.slice(this.#i + 1);
          this.#i = s.length;
        } else {
          text += s.slice(this.#i + 1, end);
          this.#i = end + 1;
        }
      } else if (char === '"') text += this.#double();
      else if (char === "$") text += this.#dollar();
      else if (char === "`") text += this.#backtick();
      else {
        text += char;
        this.#i += 1;
      }
    }
    // `find {.,-delete}` is `find . -delete`: brace expansion can produce any word.
    if (/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(bare)) this.unsafe.add("brace expansion");
    // Only a pattern without a fixed prefix (`*`, `-*`) can expand into an option-like word; `src/*` cannot.
    const glob = bare.search(/[*?]|\[.*\]/);
    const expands = (glob >= 0 && (glob === 0 || bare[0] === "-" || bare[0] === "\0")) || /^~|[=:]~/.test(bare);
    this.tokens.push({ kind: "word", text, raw: s.slice(start, this.#i), expands });
  }

  #double(): string {
    const s = this.#s;
    let text = "";
    this.#i += 1;
    while (this.#i < s.length && s[this.#i] !== '"') {
      const char = s[this.#i] as string;
      if (char === "\\" && '$`"\\\n'.includes(s[this.#i + 1] ?? "")) {
        if (s[this.#i + 1] !== "\n") text += s[this.#i + 1];
        this.#i += 2;
      } else if (char === "$") text += this.#dollar();
      else if (char === "`") text += this.#backtick();
      else {
        text += char;
        this.#i += 1;
      }
    }
    if (this.#i >= s.length) this.unsafe.add("unterminated quote");
    this.#i += 1;
    return text;
  }

  #dollar(): string {
    const s = this.#s;
    const next = s[this.#i + 1] ?? "";
    if (next === "(" && s[this.#i + 2] === "(") {
      this.unsafe.add("arithmetic expansion");
      const end = closeParen(s, this.#i + 2);
      this.#i = end < 0 ? s.length : end;
      return "";
    }
    if (next === "(") {
      this.unsafe.add("command substitution");
      const end = closeParen(s, this.#i + 2);
      this.substitutions.push(end < 0 ? s.slice(this.#i + 2) : s.slice(this.#i + 2, end - 1));
      this.#i = end < 0 ? s.length : end;
      return "";
    }
    if (next === "{") {
      this.unsafe.add("parameter expansion");
      const end = s.indexOf("}", this.#i + 2);
      this.#i = end < 0 ? s.length : end + 1;
      return "";
    }
    if (next === "'" || next === '"') {
      this.unsafe.add(next === "'" ? "ANSI-C quoting" : "locale quoting");
      this.#i += 1;
      return "";
    }
    if (/[A-Za-z0-9_@*#?$!-]/.test(next)) {
      this.unsafe.add("variable expansion");
      this.#i += 1;
      if (/[A-Za-z_]/.test(next)) while (/[A-Za-z0-9_]/.test(s[this.#i] ?? "")) this.#i += 1;
      else this.#i += 1;
      return "";
    }
    this.#i += 1;
    return "$";
  }

  #backtick(): string {
    const s = this.#s;
    let inner = "";
    let i = this.#i + 1;
    for (; i < s.length && s[i] !== "`"; i += 1) {
      if (s[i] === "\\" && i + 1 < s.length) i += 1;
      inner += s[i];
    }
    this.unsafe.add("command substitution");
    this.substitutions.push(inner);
    this.#i = i + 1;
    return "";
  }
}

function isAssignment(raw: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(raw);
}

/** Parse one command line. Nested substitutions are not parsed here; see `parseShell(…).substitutions`. */
export function parseShell(source: string): ParsedShell {
  const lexer = new Lexer(source);
  lexer.run();
  const unsafe = lexer.unsafe;
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { assignments: [], words: [], expands: [], redirects: [] };
  let pending: Redirect | null = null;
  let skipping = false;
  const finish = (): void => {
    if (current.words.length || current.assignments.length || current.redirects.length) commands.push(current);
    current = { assignments: [], words: [], expands: [], redirects: [] };
    pending = null;
    skipping = false;
  };
  for (const token of lexer.tokens) {
    if (token.kind === "redirect") {
      pending = { op: token.op, fd: token.fd, target: null };
      current.redirects.push(pending);
    } else if (token.kind === "op") {
      if (token.op === "(" && (current.words.length || current.assignments.length)) unsafe.add("function definition");
      finish();
    } else if (pending) {
      pending.target = token.text;
      pending = null;
    } else if (skipping) {
      continue;
    } else if (!current.words.length && token.raw === token.text && GROUPING.has(token.text)) {
      continue;
    } else if (!current.words.length && token.raw === token.text && RESERVED_SEPARATORS.has(token.text)) {
      unsafe.add(`shell control flow (${token.text})`);
      // `for x in …` and `case … in` heads are not commands; the bodies after `do`/`then` are.
      skipping = token.text === "for" || token.text === "select" || token.text === "case" || token.text === "function";
    } else if (!current.words.length && isAssignment(token.raw)) {
      current.assignments.push(token.raw);
    } else {
      current.words.push(token.text);
      current.expands.push(token.expands);
    }
  }
  finish();
  return { commands, substitutions: lexer.substitutions, unsafe: [...unsafe] };
}

export interface FlatCommand extends SimpleCommand {
  /** Found inside a substitution or a `sh -c` script rather than at the top level. */
  nested: boolean;
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);

/** The script of `bash -c SCRIPT …` (also `-lc`, `-ec`, `/bin/sh -c`), or null. */
export function shellScript(words: readonly string[]): string | null {
  if (!SHELLS.has((words[0] ?? "").replace(/^.*\//, ""))) return null;
  const flag = words[1] ?? "";
  if (!/^-[a-z]*c[a-z]*$/.test(flag) || words[2] === undefined) return null;
  return words[2];
}

/**
 * Every simple command a line can run, including those inside substitutions
 * and `sh -c` scripts, plus every reason it cannot be judged statically.
 */
export function flattenShell(source: string, depth = 0): { commands: FlatCommand[]; unsafe: string[] } {
  if (depth > MAX_DEPTH) return { commands: [], unsafe: ["nesting too deep"] };
  const parsed = parseShell(source);
  const commands: FlatCommand[] = [];
  const unsafe = new Set(parsed.unsafe);
  for (const command of parsed.commands) {
    commands.push({ ...command, nested: depth > 0 });
    const script = shellScript(command.words);
    if (script !== null) {
      const inner = flattenShell(script, depth + 1);
      commands.push(...inner.commands);
      for (const reason of inner.unsafe) unsafe.add(reason);
    }
  }
  for (const text of parsed.substitutions) {
    const inner = flattenShell(text, depth + 1);
    commands.push(...inner.commands);
    for (const reason of inner.unsafe) unsafe.add(reason);
  }
  return { commands, unsafe: [...unsafe] };
}
