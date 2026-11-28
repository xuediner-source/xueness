/**
 * Model-free shell preflight checks (`tool_judge.preflight`).
 *
 * Detects POSIX constructs that fail in Windows PowerShell 5.1 (respecting
 * quotes and here-strings) and checks whether direct `argv` executables or the
 * first simple command exist on `PATH` (using `node:fs`, never spawning a
 * subprocess and never probing host paths outside the workspace).
 */
import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep, win32, posix } from "node:path";

type Row = Record<string, unknown>;

export interface ShellPreflightFailure {
  rule: "shell_dialect" | "path_program";
  code: string;
  message: string;
  userReason: string;
}

const DEFAULT_WIN_EXTS = [".com", ".exe", ".bat", ".cmd", ".ps1"];

const PS_BUILTINS = new Set([
  "break", "continue", "do", "else", "elseif", "exit", "filter", "for", "foreach", "function", "if",
  "in", "param", "return", "switch", "throw", "trap", "try", "until", "while",
  "ac", "asnp", "cat", "cd", "chdir", "clc", "clear", "clhy", "cli", "clp", "cls", "clv", "cnsn",
  "compare", "copy", "cp", "cpi", "cpp", "cvpa", "dbp", "del", "diff", "dir", "dnsn", "ebp", "echo",
  "epal", "epcsv", "epsn", "erase", "etsn", "exsn", "fc", "fl", "foreach", "ft", "fw", "gal", "gbp",
  "gc", "gci", "gcm", "gcs", "gdr", "ghy", "gi", "gjb", "gl", "gm", "gmo", "gp", "gps", "gpv",
  "group", "gsnp", "gsv", "gu", "gv", "gwmi", "h", "history", "icm", "iex", "ihy", "ii", "ipal",
  "ipcsv", "ipmo", "ipsn", "irm", "ise", "iwmi", "iwr", "kill", "lp", "ls", "man", "md", "measure",
  "mi", "mkdir", "mount", "move", "mp", "mv", "nal", "ndr", "ni", "nmo", "npssc", "nsn", "nv", "ogv",
  "oh", "popd", "ps", "pushd", "pwd", "r", "rbp", "rcjb", "rcsn", "rd", "rdr", "ren", "ri", "rjb",
  "rm", "rmdir", "rmo", "rni", "rnp", "rp", "rsn", "rsnp", "rujb", "rv", "rvpa", "rwmi", "sajb",
  "sal", "saps", "sasv", "sbp", "sc", "scb", "select", "set", "shcm", "si", "sl", "sleep", "sls",
  "sort", "sp", "spjb", "spps", "spsv", "start", "sujb", "sv", "swmi", "tee", "trcm", "type",
  "where", "wjb", "write",
]);

const POSIX_BUILTINS = new Set([
  ".", ":", "[", "alias", "bg", "break", "builtin", "caller", "case", "cd", "command", "compgen",
  "complete", "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit",
  "export", "false", "fc", "fg", "for", "function", "getopts", "hash", "help", "history", "if",
  "jobs", "kill", "let", "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read",
  "readonly", "return", "set", "shift", "shopt", "source", "suspend", "test", "then", "time",
  "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until",
  "wait", "while",
]);

interface ShellScan {
  segments: string[];
  hasUnquotedAnd: boolean;
  hasUnquotedOr: boolean;
  devNullMatch: string | null;
}

/** Quote-aware single-pass scan of a PowerShell command string. */
function scanPowerShell(command: string): ShellScan {
  const segments: string[] = [];
  let buf = "";
  let hasUnquotedAnd = false;
  let hasUnquotedOr = false;
  let devNullMatch: string | null = null;
  let i = 0;

  const flush = () => {
    if (buf.trim()) segments.push(buf.trim());
    buf = "";
  };

  while (i < command.length) {
    const ch = command[i]!;
    // PowerShell here-string: @'...\n'@ or @"...\n"@
    if (ch === "@" && (command[i + 1] === "'" || command[i + 1] === '"') && (command[i + 2] === "\n" || (command[i + 2] === "\r" && command[i + 3] === "\n"))) {
      const q = command[i + 1]!;
      const terminator = `\n${q}@`;
      const crlfTerminator = `\r\n${q}@`;
      const endLf = command.indexOf(terminator, i + 2);
      const endCrlf = command.indexOf(crlfTerminator, i + 2);
      const end = endCrlf >= 0 && (endLf < 0 || endCrlf < endLf) ? endCrlf + crlfTerminator.length : endLf >= 0 ? endLf + terminator.length : command.length;
      buf += " __HERESTRING__ ";
      i = end;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < command.length) {
        if (command[i] === "'" && command[i + 1] === "'") { i += 2; continue; }
        if (command[i] === "'") { i += 1; break; }
        i += 1;
      }
      buf += " __STR__ ";
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < command.length) {
        if (command[i] === "`") { i += 2; continue; }
        if (command[i] === '"') { i += 1; break; }
        i += 1;
      }
      buf += " __STR__ ";
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;|]/.test(command[i - 1]!))) {
      while (i < command.length && command[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "`" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      hasUnquotedAnd = true;
      flush();
      i += 2;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      hasUnquotedOr = true;
      flush();
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
      flush();
      i += 1;
      continue;
    }
    if (ch === ">" && /\/dev\/null(?=$|[\s;|&)])/iu.test(command.slice(i + 1).trimStart())) {
      devNullMatch = "/dev/null";
    }
    buf += ch;
    i += 1;
  }
  flush();
  return { segments, hasUnquotedAnd, hasUnquotedOr, devNullMatch };
}

function dialectFail(message: string): ShellPreflightFailure {
  return {
    rule: "shell_dialect",
    code: "shell_dialect_mismatch",
    message,
    userReason: "前置检查拦截：命令包含 Windows PowerShell 5.1 不支持的 Shell 语法或 Unix 别名参数。",
  };
}

/** Check Windows PowerShell 5.1 compatibility pitfalls (only when `shell === "powershell"`). */
export function checkShellDialect(command: string, shell: "posix" | "powershell"): ShellPreflightFailure | null {
  if (shell !== "powershell" || typeof command !== "string" || !command.trim()) return null;
  const scanned = scanPowerShell(command);
  if (scanned.hasUnquotedAnd) {
    return dialectFail("PowerShell 5.1 does not support '&&' as a statement separator. Use ';' between commands or check '$LASTEXITCODE' explicitly.");
  }
  if (scanned.hasUnquotedOr) {
    return dialectFail("PowerShell 5.1 does not support '||'. Use 'if ($LASTEXITCODE -ne 0) { ... }' or 'try { ... } catch { ... }' instead.");
  }
  if (scanned.devNullMatch) {
    return dialectFail("PowerShell has no '/dev/null'. Use '2>$null', '>$null', or '| Out-Null' instead.");
  }
  for (const segment of scanned.segments) {
    const clean = segment.replace(/^[({\s]+/, "");
    if (!clean) continue;
    const words = clean.split(/\s+/);
    const first = words[0] ?? "";
    const lower = first.toLowerCase();
    if (lower === "export" && words.length >= 2 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[1]!)) {
      return dialectFail("PowerShell does not support 'export VAR=value'. Use '$env:VAR = value' instead.");
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(first) && words.length >= 2 && !/^(?:\$|if\b)/i.test(words[1]!)) {
      return dialectFail(`PowerShell does not support inline POSIX env prefix '${first} ${words[1]}'. Use '$env:NAME = value; ${words[1]} ...' instead.`);
    }
    // Unix short-flag clusters only, matched case-sensitively from each command's
    // own flag letters: PowerShell parameters such as -LiteralPath, -Encoding,
    // -TotalCount or -NoNewline must not look like `-la` or `-n`.
    const flags = words.slice(1).filter((word) => word.startsWith("-") && !word.startsWith("--"));
    if (lower === "ls" && flags.some((flag) => /^-[AaFRSdhilrst1]*[al][AaFRSdhilrst1]*$/.test(flag))) {
      return dialectFail("PowerShell's 'ls' alias (Get-ChildItem) does not accept Unix flags like '-la' or '-l'. Use 'Get-ChildItem -Force' or the list/glob tools.");
    }
    if (lower === "rm" && flags.some((flag) => /^-[dfiRrv]*(?:[rR]f|f[rR])[dfiRrv]*$/.test(flag))) {
      return dialectFail("PowerShell's 'rm' alias (Remove-Item) does not accept '-rf'. Use 'Remove-Item -Recurse -Force' instead.");
    }
    if (lower === "cp" && flags.some((flag) => /^-(?:rf|fr|Rf|fR|a|rp|ar)$/.test(flag))) {
      return dialectFail("PowerShell's 'cp' alias (Copy-Item) does not accept Unix '-rf' or '-a'. Use 'Copy-Item -Recurse -Force' instead.");
    }
    if (lower === "cat" && flags.some((flag) => /^-[AbeEstTuv]*n[AbeEstTuv]*$/.test(flag))) {
      return dialectFail("PowerShell's 'cat' alias (Get-Content) does not support '-n' line numbering. Use the read tool instead.");
    }
  }
  return null;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function isFileStat(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executableExtensions(target: string, isWin: boolean, env: NodeJS.ProcessEnv): string[] {
  if (extname(target)) return [""];
  if (!isWin) return [""];
  const raw = envValue(env, "PATHEXT");
  const list = raw ? raw.split(";").map((item) => item.trim().toLowerCase()).filter(Boolean) : DEFAULT_WIN_EXTS;
  if (!list.includes(".ps1")) list.push(".ps1");
  return ["", ...list];
}

function existsInPath(commandName: string, isWin: boolean, env: NodeJS.ProcessEnv): boolean | null {
  const rawPath = envValue(env, "PATH") ?? "";
  const dirs = rawPath.split(delimiter).map((dir) => dir.trim()).filter(Boolean);
  if (!dirs.length) return null; // empty env in synthetic test -> fail open
  const exts = executableExtensions(commandName, isWin, env);
  const pathJoin = isWin ? win32.join : posix.join;
  for (const dir of dirs) {
    for (const ext of exts) {
      if (isFileStat(pathJoin(dir, `${commandName}${ext}`))) return true;
    }
  }
  return false;
}

function firstSimpleCommandWord(command: string, shell: "posix" | "powershell"): string | null {
  if (/ \|\| |Get-Command\b|command\s+-v\b|\bwhich\b|\bwhere\.exe\b|\$env:PATH\b|export\s+PATH=|\bPATH=/iu.test(command)) {
    return null;
  }
  // The first line that runs something: blank lines, comments and a shebang come first in scripts.
  const statement = command.split(/\r?\n/).map((text) => text.trim()).find((text) => text !== "" && !text.startsWith("#")) ?? "";
  const line = statement.split(/[;|&]/)[0]?.trim() ?? "";
  if (!line) return null;
  if (/^[$.&({@[\"'!]/.test(line)) return null;
  const word = line.split(/\s+/)[0] ?? "";
  if (!word || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /[$`*?{}\[\]()<>]/.test(word)) return null;
  const lower = word.toLowerCase();
  if (shell === "powershell") {
    if (PS_BUILTINS.has(lower) || /^[A-Za-z]+-[A-Za-z0-9]+$/.test(word)) return null;
  } else {
    if (POSIX_BUILTINS.has(word)) return null;
  }
  return word;
}

function withinWorkspace(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** Check direct `argv[0]` or the first simple command word in `command` on PATH or inside workspace. */
export function checkProgramOnPath(
  input: Row,
  options: { shell: "posix" | "powershell"; root: string; env: NodeJS.ProcessEnv; shellInitConfigured?: boolean },
): ShellPreflightFailure | null {
  if (options.shellInitConfigured) return null;
  const isWin = options.shell === "powershell" || process.platform === "win32";
  let target: string | null = null;
  if (Array.isArray(input.argv) && input.argv.length > 0 && typeof input.argv[0] === "string") {
    target = input.argv[0].trim();
  } else if (typeof input.command === "string") {
    target = firstSimpleCommandWord(input.command, options.shell);
  }
  if (!target) return null;

  if (target.includes("/") || target.includes("\\")) {
    const resolved = isAbsolute(target) ? resolve(target) : resolve(options.root, target);
    // Security: never probe arbitrary host paths outside the workspace.
    if (!withinWorkspace(options.root, resolved)) return null;
    const exts = executableExtensions(target, isWin, options.env);
    if (exts.some((ext) => isFileStat(`${resolved}${ext}`))) return null;
    return {
      rule: "path_program",
      code: "command_not_found",
      message: `command not found in workspace: ${target}`,
      userReason: `前置检查拦截：工作区内未找到可执行文件「${target}」。`,
    };
  }

  const found = existsInPath(target, isWin, options.env);
  if (found !== false) return null;
  return {
    rule: "path_program",
    code: "command_not_found",
    message: `command not found on PATH: ${target}`,
    userReason: `前置检查拦截：当前 PATH 中找不到命令「${target}」。`,
  };
}
