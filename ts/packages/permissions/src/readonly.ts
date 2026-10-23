/**
 * Which commands only read.
 *
 * A command line is read-only when the parser found nothing it cannot judge
 * (expansions, substitutions, control flow…), no command sets variables,
 * every redirection only reads, duplicates a descriptor or writes to
 * /dev/null, and every simple command is a known reader whose arguments
 * cannot make it write or run something else (`find -delete`, `sort -o`,
 * `git -c`, `sed -i`, `rg --pre` are not). Such readers also refuse glob
 * words, which a file named `--pre=bash` turns into options. No argument may
 * point outside the workspace (`/…`, `~`, `..`), so `cat ~/.ssh/id_rsa` asks.
 * Programs given by path are never read-only: `./ls` may be anything.
 * Unknown means "ask", never "allow".
 */
import { argvPolicyReadOnly, gitAndDirectoryChange, stricterArgvReason } from "./readonly-argv-bridge.ts";
import { isSafeEnvAssignment, isUnsafeWindowsUncPath, stripSafeCommandWrappers } from "./readonly-argv-io.ts";
import { READONLY_ALLOW_ANY_ARG_COMMANDS } from "./readonly-argv-simple.ts";
import { parseShell, shellScript, type Redirect, type SimpleCommand } from "./shell-parse.ts";

export interface Classification {
  readOnly: boolean;
  reason: string;
}

type Check = (args: readonly string[]) => string | null;

const ok: Check = () => null;
const none = (name: string): Check => (args) => (args.length ? `${name} with arguments` : null);
/** Reject listed options, also inside short-option clusters (`-uo` contains `-o`). */
const without = (long: readonly string[], short = ""): Check => (args) => {
  for (const arg of args) {
    if (arg === "--") break;
    if (long.some((option) => arg === option || arg.startsWith(`${option}=`))) return `option ${arg}`;
    if (short && /^-[A-Za-z0-9]+$/.test(arg) && [...arg.slice(1)].some((letter) => short.includes(letter))) return `option ${arg}`;
  }
  return null;
};
const positional = (args: readonly string[]): string[] => args.filter((arg) => !arg.startsWith("-"));

const VERSION_FLAGS = new Set(["--version", "-v", "-V"]);
/** Version queries spelled differently; `make version` would run a Makefile target. */
const VERSION_WORDS: Record<string, string> = { java: "-version", javac: "-version", go: "version", docker: "version", gh: "version", cargo: "version" };
const TOOLCHAINS = [
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "tsc", "python", "python3", "pip", "pip3", "uv", "go", "cargo", "rustc",
  "java", "javac", "gcc", "g++", "cc", "clang", "clang++", "make", "cmake", "ruby", "gem", "php", "perl", "dotnet", "docker", "git", "gh",
];

/**
 * True when a sed script only prints, deletes, quits or substitutes on
 * stdout: addresses (`N`, `$`, `/re/`, ranges), the commands p d q Q = l n
 * N P D, and `s///` with flags g p i I m and digits. No w/W/r/R/e, no `s///w`
 * or `s///e`, no blocks: anything else is not read-only.
 */
export function sedScriptReadOnly(script: string): boolean {
  const n = script.length;
  let i = 0;
  const at = (offset = 0): string => script[i + offset] ?? "";
  const spaces = (): void => {
    while (at() === " " || at() === "\t") i += 1;
  };
  const digits = (): boolean => {
    const from = i;
    while (/\d/.test(at())) i += 1;
    return i > from;
  };
  /** Move past the closing `delim` of a regex or replacement whose first character is at `i`. */
  const field = (delim: string): boolean => {
    for (; i < n; i += 1) {
      if (script[i] === "\\") i += 1;
      else if (script[i] === "\n") return false;
      else if (script[i] === delim) {
        i += 1;
        return true;
      }
    }
    return false;
  };
  const address = (): boolean => {
    if (digits()) return true;
    if (at() === "$") return (i += 1), true;
    if (at() === "/") return (i += 1), field("/");
    return true;
  };
  while (i < n) {
    while (/[\s;]/.test(at())) i += 1;
    if (i >= n) break;
    if (!address()) return false;
    spaces();
    if (at() === ",") {
      i += 1;
      spaces();
      if (at() === "+" || at() === "~") {
        i += 1;
        if (!digits()) return false;
      } else if (!address()) return false;
      spaces();
    }
    if (at() === "!") {
      i += 1;
      spaces();
    }
    const command = at();
    i += 1;
    if (command === "q" || command === "Q") digits();
    else if (command === "s") {
      const delim = at();
      if (!delim || delim === "\\" || delim === "\n" || delim === " ") return false;
      i += 1;
      if (!field(delim) || !field(delim)) return false;
      while (/[gpiIm0-9]/.test(at())) i += 1;
    } else if (!command || !"pd=lnNPD".includes(command)) return false;
    spaces();
    if (i < n && at() !== ";" && at() !== "\n") return false;
  }
  return true;
}

const sed: Check = (args) => {
  const scripts: string[] = [];
  let explicit = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-e" || arg === "--expression") {
      scripts.push(args[i + 1] ?? "");
      explicit = true;
      i += 1;
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      explicit = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      if (!/^(?:-[nErsuz]+|--quiet|--silent|--posix|--regexp-extended|--null-data|--separate|--unbuffered|--sandbox|--debug)$/.test(arg)) return `option ${arg}`;
    } else if (!explicit && !scripts.length) scripts.push(arg);
  }
  if (!scripts.length) return "no script";
  return scripts.every(sedScriptReadOnly) ? null : "a sed script that may write or run commands";
};

const GIT_READ = new Set([
  "status", "log", "show", "diff", "blame", "annotate", "shortlog", "describe", "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote",
  "cat-file", "grep", "merge-base", "name-rev", "for-each-ref", "show-ref", "count-objects", "whatchanged", "version", "cherry",
  "range-diff", "diff-tree", "diff-files", "diff-index", "var", "check-ignore", "check-attr", "show-branch", "verify-commit", "verify-tag",
]);
const GIT_LISTING = /^(?:-[avrlin]+|--(?:all|remotes|verbose|list|show-current|ignore-case|no-color|merged|no-merged|contains|no-contains|points-at|omit-empty)|--(?:sort|format|color|column|merged|no-merged|contains|no-contains|points-at|abbrev)=.*|-n\d*)$/;
const GIT_VALUE_OPTIONS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);

function gitListing(args: readonly string[], listFlag: RegExp): string | null {
  let positionals = 0;
  let listing = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith("-")) {
      if (!GIT_LISTING.test(arg)) return `option ${arg}`;
      if (listFlag.test(arg)) listing = true;
      if (GIT_VALUE_OPTIONS.has(arg)) i += 1;
    } else positionals += 1;
  }
  return positionals && !listing ? "creates or changes refs" : null;
}

const git: Check = (args) => {
  if (args.length === 1 && (VERSION_FLAGS.has(args[0] as string) || args[0] === "version")) return null;
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") i += 1;
    else if (/^(?:--no-pager|-P|--no-optional-locks|--literal-pathspecs|--no-replace-objects|--bare|--git-dir=.*|--work-tree=.*)$/.test(arg)) continue;
    else if (arg.startsWith("-")) return `git option ${arg}`;
    else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return "no git subcommand";
  if (GIT_READ.has(sub)) {
    const bad = without(["--output", "--ext-diff", "--open-files-in-pager", "--exec"], sub === "grep" ? "O" : "")(rest);
    return bad ? `git ${sub} ${bad}` : null;
  }
  if (sub === "branch") return gitListing(rest, /^(?:-[a-z]*l[a-z]*|--list)$/);
  if (sub === "tag") return gitListing(rest, /^(?:-[a-z]*l[a-z]*|--list|-n\d*)$/);
  if (sub === "stash" || sub === "worktree" || sub === "notes" || sub === "reflog" || sub === "submodule") {
    const allowed: Record<string, readonly string[]> = { stash: ["list", "show"], worktree: ["list"], notes: ["list", "show"], reflog: ["show"], submodule: ["status"] };
    return rest.length === 0 && sub === "reflog" ? null : (allowed[sub] as readonly string[]).includes(rest[0] ?? "") ? null : `git ${sub} ${rest[0] ?? ""}`.trim();
  }
  if (sub === "remote") {
    if (rest.every((arg) => arg === "-v" || arg === "--verbose")) return null;
    return rest[0] === "get-url" || rest[0] === "show" ? null : `git remote ${rest[0]}`;
  }
  if (sub === "config") {
    if (rest[0] === "get" || rest[0] === "list") return null;
    return rest.some((arg) => /^(?:--get(?:-all|-regexp|-urlmatch|-color(?:bool)?)?|--list|-l)$/.test(arg)) && !rest.some((arg) => /^(?:--(?:add|unset|unset-all|replace-all|rename-section|remove-section|edit)|-e)$/.test(arg))
      ? null : "git config that may write";
  }
  return `git ${sub}`;
};

const DATE_ARG = /^(?:\+.*|-u|--utc|--universal|-R|--rfc-email|-I\w*|--iso-8601(?:=\w+)?|--rfc-3339=\w+|--date=.*|--reference=.*)$/;
const date: Check = (args) => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-d" || arg === "--date" || arg === "-r" || arg === "--reference") i += 1;
    else if (!DATE_ARG.test(arg)) return `date ${arg}`;
  }
  return null;
};

const npm: Check = (args) => {
  const [sub, ...rest] = args;
  if (sub === undefined) return "no npm command";
  if ((VERSION_FLAGS.has(sub) || sub === "version") && !rest.length) return null;
  if (["ls", "list", "ll", "la", "view", "info", "show", "v", "outdated", "explain", "why", "root", "prefix"].includes(sub)) return null;
  if (sub === "config" && (rest[0] === "get" || rest[0] === "list" || rest[0] === "ls")) return null;
  if (sub === "audit" && !rest.includes("fix")) return null;
  return `npm ${sub}`;
};

const READERS: Record<string, Check> = {
  cat: ok, head: ok, tail: ok, wc: ok, echo: ok, printf: ok, pwd: ok, ls: ok, dirname: ok, basename: ok, realpath: ok, readlink: ok,
  stat: ok, du: ok, df: ok, cut: ok, tr: ok, nl: ok, rev: ok, tac: ok, fold: ok, expand: ok, unexpand: ok, paste: ok, join: ok, comm: ok,
  cmp: ok, diff: ok, column: ok, strings: ok, od: ok, hexdump: ok, base64: ok, md5sum: ok, sha1sum: ok, sha224sum: ok, sha256sum: ok,
  sha384sum: ok, sha512sum: ok, b2sum: ok, cksum: ok, true: ok, false: ok, test: ok, "[": ok, which: ok, type: ok, whoami: ok, id: ok,
  groups: ok, uname: ok, nproc: ok, uptime: ok, printenv: ok, seq: ok, sleep: ok, grep: ok, egrep: ok, fgrep: ok, jq: ok, ps: ok,
  pgrep: ok, locale: ok, arch: ok, cal: ok,
  // Bare `cd` and `cd -` go home or back, and the next command may read there.
  cd: (args) => (args.length !== 1 || (args[0] as string).startsWith("-") ? "cd that may leave the workspace" : null),
  env: none("env"), hostname: (args) => (args.every((arg) => /^-[fsiIdaA]$/.test(arg)) ? null : "hostname that may set the name"),
  command: (args) => (/^-[vV]$/.test(args[0] ?? "") ? null : "command that runs a program"),
  date, sed, git, npm,
  sort: without(["--output", "--compress-program"], "o"),
  uniq: (args) => (positional(args).length > 1 ? "uniq writing an output file" : null),
  // tree -R writes 00Tree.html into every directory.
  tree: without(["-o"], "oR"),
  file: without(["--compile"], "C"),
  find: (args) => {
    const bad = args.find((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg));
    return bad ? `find ${bad}` : null;
  },
  fd: without(["--exec", "--exec-batch"], "xX"),
  fdfind: without(["--exec", "--exec-batch"], "xX"),
  rg: without(["--pre"]),
};

/** Wrappers that run the rest of the line unchanged: their inner command decides. */
export function unwrapCommand(words: readonly string[]): string[] | null {
  const [head, ...rest] = words;
  if (head === "nohup" || head === "time") return rest;
  if (head === "nice") return rest[0] === "-n" ? rest.slice(2) : /^-\d+$/.test(rest[0] ?? "") ? rest.slice(1) : rest;
  if (head === "timeout") {
    let i = 0;
    while (i < rest.length && (rest[i] as string).startsWith("-")) i += rest[i] === "-s" || rest[i] === "-k" || rest[i] === "--signal" || rest[i] === "--kill-after" ? 2 : 1;
    return rest.slice(i + 1);
  }
  if (head === "stdbuf") return rest.slice(rest.findIndex((arg) => !arg.startsWith("-")) >>> 0);
  return null;
}

/** Commands whose arguments are not files. */
const NO_FILE_ARGS = new Set(["echo", "printf", "true", "false", "sleep", "seq", "which", "type", "command", "basename", "dirname", "test", "["]);
/** An absolute or home path, also as an option value (`-f/etc/x`, `--file=~/x`), or a `..` segment. */
const OUTSIDE = /^(?:-[A-Za-z]+)?(?:~|\/(?!dev\/null$))|=(?:~|\/)|(?:^|[/=])\.\.(?:\/|$)/;
/** Readers whose first operand is a pattern or a script (`sed -n '/x/p' f`), unless `-e`/`-f` give it. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "sed", "jq"]);

function pathArgs(program: string, args: readonly string[]): readonly string[] {
  if (NO_FILE_ARGS.has(program)) return [];
  if (!PATTERN_FIRST.has(program) || args.some((arg) => /^-(?:e|f|-regexp|-file|-expression|-from-file)/.test(arg))) return args;
  const index = args.findIndex((arg) => !arg.startsWith("-"));
  return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 1)];
}

/** Stricter than the argv allow-list: workspace jail, globs that become flags, and a few writers the allow-any list would miss. */
function xuenessGuards(program: string, args: readonly string[], expands: readonly boolean[]): Classification | null {
  if (expands.slice(1).some(Boolean) && !READONLY_ALLOW_ANY_ARG_COMMANDS.has(program)) {
    return { readOnly: false, reason: `${program} with a pattern that may expand to options` };
  }
  const escape = pathArgs(program, args).find((arg) => OUTSIDE.test(arg));
  if (escape !== undefined) return { readOnly: false, reason: `may read outside the workspace (${escape})` };
  if (program === "cd") {
    const problem = (args.length !== 1 || (args[0] as string).startsWith("-")) ? "cd that may leave the workspace" : null;
    if (problem) return { readOnly: false, reason: problem };
  }
  // xargs takes arguments from stdin, so the workspace jail above cannot see them.
  if (program === "xargs") return { readOnly: false, reason: "xargs takes its arguments from input" };
  if (program === "uniq" && positional(args).length > 1) return { readOnly: false, reason: "uniq writing an output file" };
  if (program === "sed") {
    const problem = sed(args);
    if (problem) return { readOnly: false, reason: problem };
  }
  return null;
}

function legacyReaders(program: string, args: readonly string[], expands: readonly boolean[]): Classification {
  const check = READERS[program];
  if (check) {
    if (check !== ok && expands.slice(1).some(Boolean)) return { readOnly: false, reason: `${program} with a pattern that may expand to options` };
    const escape = pathArgs(program, args).find((arg) => OUTSIDE.test(arg));
    if (escape !== undefined) return { readOnly: false, reason: `may read outside the workspace (${escape})` };
    const problem = check(args);
    return problem ? { readOnly: false, reason: problem } : { readOnly: true, reason: program };
  }
  const version = args.length === 1 && (VERSION_FLAGS.has(args[0] as string) || VERSION_WORDS[program] === args[0]);
  if (TOOLCHAINS.includes(program) && version) return { readOnly: true, reason: `${program} version` };
  return { readOnly: false, reason: `${program} is not a known read-only command` };
}

function classifyWords(words: readonly string[], depth: number, expands: readonly boolean[] = []): Classification {
  const inner = unwrapCommand(words);
  if (inner) {
    if (!inner.length) return { readOnly: false, reason: `${words[0]} without a command` };
    return classifyWords(inner, depth, expands.slice(words.length - inner.length));
  }
  // `command`/`builtin`/`noglob` run the rest unchanged: judge (and guard) the inner command.
  const stripped = stripSafeCommandWrappers(words);
  if (stripped.length && stripped.length < words.length) {
    const verdict = classifyWords(stripped, depth, expands.slice(words.length - stripped.length));
    return verdict.readOnly ? verdict : { readOnly: false, reason: `${words[0]} that runs a program: ${verdict.reason}` };
  }
  const program = words[0] as string;
  const args = words.slice(1);
  if (expands[0]) return { readOnly: false, reason: "the command name is a pattern" };
  if (program.includes("/")) return { readOnly: false, reason: `runs a program by path (${program})` };
  const script = shellScript(words);
  if (script !== null && depth < 2) {
    const verdict = classifyShellCommand(script, depth + 1);
    return verdict.readOnly ? { readOnly: true, reason: verdict.reason } : verdict;
  }
  const policy = argvPolicyReadOnly(words);
  if (policy === true) {
    return xuenessGuards(program, args, expands) ?? { readOnly: true, reason: program };
  }
  const legacy = legacyReaders(program, args, expands);
  if (policy === false && legacy.readOnly) return { readOnly: false, reason: stricterArgvReason(words) };
  return legacy;
}

/**
 * Reads, duplicates a descriptor onto a number, or aims at /dev/null.
 * Device (`/dev/tcp`, `/dev/udp`) and UNC targets are rejected, matching the
 * argv policy's redirect check.
 */
export function redirectReadOnly(redirect: Redirect): boolean {
  if (redirect.target === null) return false;
  if (/^\/dev\/(?:tcp|udp)\//.test(redirect.target) || isUnsafeWindowsUncPath(redirect.target)) return false;
  if (redirect.op === ">&" && /^\d+$/.test(redirect.target)) return true;
  if (redirect.target === "/dev/null") return true;
  // Reading a file from outside the workspace is not a workspace read.
  if (redirect.op === "<" && OUTSIDE.test(redirect.target)) return false;
  return redirect.op === "<" || redirect.op === "<<" || redirect.op === "<&" || redirect.op === "<<<";
}

/** Classify one simple command of a parsed line. */
export function classifySimpleCommand(command: SimpleCommand, depth = 0): Classification {
  if (command.assignments.length) {
    const unsafe = command.assignments.find((token) => !isSafeEnvAssignment(token));
    if (unsafe) return { readOnly: false, reason: `sets ${unsafe.split(/[+=]/)[0]}` };
  }
  const bad = command.redirects.find((redirect) => !redirectReadOnly(redirect));
  if (bad) return { readOnly: false, reason: `redirection ${bad.op}${bad.target ?? ""}` };
  if (!command.words.length) return { readOnly: true, reason: "redirection only" };
  return classifyWords(command.words, depth, command.expands);
}

/** Classify a POSIX shell command line. */
export function classifyShellCommand(line: string, depth = 0): Classification {
  const parsed = parseShell(line);
  if (parsed.unsafe.length) return { readOnly: false, reason: parsed.unsafe[0] as string };
  if (!parsed.commands.length) return { readOnly: false, reason: "empty command" };
  if (gitAndDirectoryChange(parsed.commands)) return { readOnly: false, reason: "git after a directory change" };
  const reasons: string[] = [];
  for (const command of parsed.commands) {
    const verdict = classifySimpleCommand(command, depth);
    if (!verdict.readOnly) return verdict;
    reasons.push(verdict.reason);
  }
  return { readOnly: true, reason: [...new Set(reasons)].join(", ") };
}

/** Classify an argv run without a shell. */
export function classifyArgv(argv: readonly string[]): Classification {
  if (!argv.length) return { readOnly: false, reason: "empty command" };
  return classifyWords(argv, 0);
}
