/** Finite command checks for guarded mode. This is a prompt matcher, not an OS sandbox. */
import { parseShell } from "@xueness/contracts";

export type GuardedShell = "posix" | "git-bash" | "powershell" | "cmd";
export type GuardedCommandResult =
  | { status: "matched"; ruleId: string }
  | { status: "notMatched" | "unsupported" };

export interface GuardedRequest {
  readonly tool: string;
  readonly kind: string;
  readonly subject: string;
  readonly subjectKind: string;
}

export interface GuardedPermission {
  readonly ruleId: string;
  readonly message: string;
}

const MATCH = (ruleId: string): GuardedCommandResult => ({ status: "matched", ruleId: `guarded.${ruleId}` });
const UNSUPPORTED: GuardedCommandResult = { status: "unsupported" };
const NOT_MATCHED: GuardedCommandResult = { status: "notMatched" };
const basename = (word: string): string => (word.split(/[\\/]/).at(-1) ?? "").replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
const isGlob = (word: string): boolean => /\*|\?|\[/.test(word);

/**
 * Inspect the actual exec subject (the command text, or shell-quoted argv joined by
 * engine-tools). The supported grammar is intentionally finite; CMD is unsupported.
 */
export function matchGuardedCommand(command: string, shell: GuardedShell): GuardedCommandResult {
  if (typeof command !== "string" || command.length > 10_000 || shell === "cmd") return UNSUPPORTED;
  const parsed = parseShell(command);
  let unsupported = parsed.unsafe.length > 0;
  for (const simple of parsed.commands) {
    if (simple.expands.some(Boolean)) unsupported = true;
    if (!simple.words.length) {
      if (simple.assignments.length || simple.redirects.length) unsupported = true;
      continue;
    }
    const unwrapped = unwrap(simple.words, shell === "powershell");
    if (!unwrapped) {
      unsupported = true;
      continue;
    }
    const [nameWord, ...args] = unwrapped;
    const name = basename(nameWord ?? "");
    if (!name) {
      unsupported = true;
      continue;
    }
    if (isShellCommand(name, args, shell)) {
      unsupported = true;
      continue;
    }
    const result = shell === "powershell" ? matchPowerShell(name, args) : matchPosix(name, args);
    if (result.status === "matched") return result;
    if (result.status === "unsupported") unsupported = true;
  }
  return unsupported ? UNSUPPORTED : NOT_MATCHED;
}

/** Callback for PermissionSettings.guarded; only a known match creates a prompt. */
export function guardedPermission(request: GuardedRequest, shell: GuardedShell): GuardedPermission | null {
  if (request.tool !== "exec" || request.kind !== "exec" || request.subjectKind !== "command") return null;
  const result = matchGuardedCommand(request.subject, shell);
  return result.status === "matched"
    ? { ruleId: result.ruleId, message: `guarded mode requires one-time approval for ${result.ruleId}` }
    : null;
}

function isShellCommand(name: string, args: string[], shell: GuardedShell): boolean {
  const posix = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
  if (shell !== "powershell" && posix.has(name)) return /^-[a-z]*c[a-z]*$/i.test(args[0] ?? "");
  if (shell === "powershell" && ["powershell", "pwsh"].includes(name)) {
    return args.some((arg) => /^-(?:c|command|encodedcommand)$/i.test(arg));
  }
  return false;
}

/** Unwrap only common, unambiguous sudo/env/command forms. */
function unwrap(input: string[], powershell: boolean): string[] | null {
  let words = [...input];
  for (let depth = 0; depth < 4; depth += 1) {
    const name = basename(words[0] ?? "");
    if (name === "sudo" || (!powershell && name === "env") || (!powershell && name === "command")) {
      let i = 1;
      while (i < words.length && (words[i] ?? "").startsWith("-") && words[i] !== "--") {
        const opt = words[i++] ?? "";
        const key = opt.split("=", 1)[0]?.toLowerCase() ?? opt.toLowerCase();
        if (name === "command") {
          if (key !== "-p") return null;
        } else if (name === "env") {
          if (["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(key)) continue;
          if (["-u", "--unset", "-c", "--chdir"].includes(key)) { if (!opt.includes("=")) i += 1; }
          else return null;
        } else {
          if (["-e", "--preserve-env", "-H", "--set-home", "-n", "--non-interactive", "-s", "--stdin", "-a", "--askpass", "-b", "--background", "-k", "--reset-timestamp"].includes(key)) continue;
          if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-c", "--close-from", "-t", "--command-timeout", "-d", "--chdir", "-r", "--chroot"].includes(key)) { if (!opt.includes("=")) i += 1; }
          else return null;
        }
        if (i > words.length) return null;
      }
      if (words[i] === "--") i += 1;
      words = words.slice(i);
      if (name === "sudo" || name === "env") while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
      if (!words.length) return null;
      continue;
    }
    return words;
  }
  return null;
}

function matchPosix(name: string, args: string[]): GuardedCommandResult {
  if (name === "rm") return matchRm(args);
  if (name === "git") return matchGit(args);
  if (name === "find") return matchFind(args);
  if (name === "rsync") return matchRsync(args);
  if (["dd", "umount"].includes(name) || name === "mount" || name === "mkfs" || /^mkfs\.[\w-]+$/.test(name)) {
    const query = args.length === 1 && ["--help", "--version", "-h", "-V", "-l", "--list"].includes(args[0] ?? "");
    if (query || (name === "mount" && args.length === 0)) return NOT_MATCHED;
    return MATCH("system-storage");
  }
  return NOT_MATCHED;
}

function matchRm(args: string[]): GuardedCommandResult {
  let recursive = false;
  let targets = 0;
  let unsupported = false;
  let endOptions = false;
  for (const arg of args) {
    if (!endOptions && arg === "--") { endOptions = true; continue; }
    if (!endOptions && arg.startsWith("-") && arg !== "-") {
      if (arg.startsWith("--")) {
        if (["--recursive"].includes(arg)) recursive = true;
        else if (["--force", "--interactive", "--verbose", "--dir", "--help", "--version", "--one-file-system", "--preserve-root", "--no-preserve-root"].includes(arg)) continue;
        else unsupported = true;
      } else {
        for (const flag of arg.slice(1)) {
          if (flag === "r" || flag === "R") recursive = true;
          else if (!["f", "i", "I", "v", "d"].includes(flag)) unsupported = true;
        }
      }
      continue;
    }
    targets += 1;
    if (isGlob(arg)) targets += 1;
  }
  return recursive || targets >= 2 ? MATCH("remove-tree") : unsupported ? UNSUPPORTED : NOT_MATCHED;
}

function matchGit(args: string[]): GuardedCommandResult {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "-") {
    const arg = args[i++]!;
    const key = arg.split("=", 1)[0]!.toLowerCase();
    if (["--no-pager", "-p", "--paginate", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--bare", "--no-replace-objects", "--no-optional-locks"].includes(key)) continue;
    const valued = ["-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix"];
    if (valued.includes(key)) { if (!arg.includes("=")) i += 1; }
    else return UNSUPPORTED;
    if (i > args.length) return UNSUPPORTED;
  }
  const command = (args[i++] ?? "").toLowerCase();
  const rest = args.slice(i);
  if (["reset", "clean", "push", "checkout", "restore", "branch"].includes(command)) return matchGitCommand(command, rest);
  return command ? NOT_MATCHED : UNSUPPORTED;
}

function matchGitCommand(command: string, args: string[]): GuardedCommandResult {
  let hard = false, force = false, dryRun = false, deleteBranch = false, pushDelete = false;
  let endOptions = false;
  let unknown = false;
  const operands: string[] = [];
  const values = new Set(["--repo", "--receive-pack", "--exec", "-o", "--push-option", "-C", "--conflict", "-b", "-B", "--orphan", "-s", "--source"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!endOptions && arg === "--") { endOptions = true; continue; }
    if (endOptions || !arg.startsWith("-") || arg === "-") { operands.push(arg); continue; }
    const key = arg.split("=", 1)[0]!.toLowerCase();
    if (values.has(key)) { if (!arg.includes("=")) i += 1; if (i >= args.length) unknown = true; continue; }
    if (key === "--hard") hard = true;
    else if (command === "branch" && ["--delete", "-d", "-D"].includes(key)) deleteBranch = true;
    else if (command === "push" && ["--delete", "-d"].includes(key)) pushDelete = true;
    else if (["--force", "--mirror", "--force-with-lease"].includes(key)) force = true;
    else if (key === "--dry-run" || key === "-n") dryRun = true;
    else if (key === "--no-dry-run") dryRun = false;
    else if (["-q", "--quiet", "-v", "--verbose", "-h", "--help", "--soft", "--mixed", "--merge", "--keep", "-p", "--patch", "-n", "--no-dry-run", "-x", "-X", "-i", "--interactive", "--no-force", "--no-mirror", "--no-force-with-lease", "--all", "--branches", "--tags", "--prune", "--atomic", "--no-atomic", "--porcelain", "--follow-tags", "--no-follow-tags", "-u", "--set-upstream", "--thin", "--no-thin", "--progress", "--no-progress", "--ipv4", "-4", "--ipv6", "-6", "-f", "--ours", "--theirs", "-m", "--merge", "--ignore-other-worktrees", "--recurse-submodules", "--no-recurse-submodules", "--overlay", "--no-overlay", "-W", "--worktree", "--no-worktree", "-S", "--staged", "--no-staged", "--ignore-unmerged"].includes(key)) {
      if (key === "-f" || key === "--force") force = true;
      // Bundled short options are conservatively scanned for force/delete evidence.
      if (/^-[^-]{2,}$/.test(arg)) {
        if (arg.slice(1).includes("f")) force = true;
        if (arg.slice(1).includes("D") || arg.slice(1).includes("d")) deleteBranch = true;
      }
    }
    else unknown = true;
  }
  if (command === "reset" && hard) return MATCH("git-reset-hard");
  if (command === "clean" && force && !dryRun) return MATCH("git-clean-force");
  if (command === "push" && !dryRun && (force || operands.some((word) => word.startsWith("+")))) return MATCH("git-push-force");
  if (command === "push" && !dryRun && pushDelete) return MATCH("git-branch-delete");
  if (command === "branch" && deleteBranch) return MATCH("git-branch-delete");
  if (command === "checkout") {
    if (force || (operands.length > 0 && (endOptions || operands.some((word) => [".", "./", ":/"].includes(word))))) return MATCH("git-checkout-discard");
  }
  if (command === "restore" && operands.length > 0) return MATCH("git-restore-discard");
  return unknown ? UNSUPPORTED : NOT_MATCHED;
}

const FIND_FLAGS = new Set("-H -L -P -O0 -O1 -O2 -O3 -depth -d -x -xdev -mount -ignore_readdir_race -noignore_readdir_race -daystart -follow -noleaf -true -false -empty -readable -writable -executable -print -print0 -ls -prune -quit -a -and -o -or -not ! ( ) ,".split(" "));
const FIND_VALUES = new Set("-D -f -name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -size -user -group -uid -gid -perm -links -inum -samefile -newer -anewer -cnewer -atime -ctime -mtime -amin -cmin -mmin -used -maxdepth -mindepth -printf -fprint -fprint0 -fls -files0-from".split(" "));
function matchFind(args: string[]): GuardedCommandResult {
  let expression = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!expression && !arg.startsWith("-") && !["!", "("].includes(arg)) continue;
    if (["-H", "-L", "-P", "-O0", "-O1", "-O2", "-O3", "-d", "-x"].includes(arg) && !expression) continue;
    if (["-D", "-f"].includes(arg) && !expression) { if (!args[++i]) return UNSUPPORTED; continue; }
    expression = true;
    if (arg === "-delete") return MATCH("find-delete");
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) {
      let closed = false;
      while (++i < args.length) if (args[i] === ";" || (args[i] === "+" && args[i - 1] === "{}" && ["-exec", "-execdir"].includes(arg))) { closed = true; break; }
      if (!closed) return UNSUPPORTED;
    } else if (FIND_VALUES.has(arg) || /^-newer[acmBt][acmBt]$/.test(arg)) { if (!args[++i]) return UNSUPPORTED; }
    else if (!FIND_FLAGS.has(arg)) return UNSUPPORTED;
  }
  return NOT_MATCHED;
}

const RSYNC_DELETE = new Set(["--delete", "--del", "--delete-before", "--delete-during", "--delete-delay", "--delete-after", "--delete-excluded"]);
function matchRsync(args: string[]): GuardedCommandResult {
  const deletion = args.some((arg) => RSYNC_DELETE.has(arg));
  if (deletion && args.some((arg) => ["-n", "--dry-run"].includes(arg))) return NOT_MATCHED;
  if (deletion) return MATCH("rsync-delete");
  return args.some((arg) => arg.startsWith("-") && !["-a", "-r", "-v", "-q", "-z", "-h", "-P", "-p", "-t", "-g", "-o", "-D", "-l", "-H", "-A", "-X", "-u", "-c", "--archive", "--recursive", "--verbose", "--quiet", "--compress", "--progress", "--partial", "--checksum", "--update", "--numeric-ids", "--ignore-errors", "--force", "--help", "--version", "--dry-run"].includes(arg)) ? UNSUPPORTED : NOT_MATCHED;
}

function matchPowerShell(name: string, args: string[]): GuardedCommandResult {
  if (["clear-disk", "format-volume", "initialize-disk", "remove-partition"].includes(name)) return MATCH(`powershell-${name}`);
  if (!["remove-item", "ri", "del", "rm"].includes(name)) return NOT_MATCHED;
  if (args.length === 0) return UNSUPPORTED;
  let recurse = false, targets = 0, glob = false, unsupported = false;
  const takesValue = new Set(["path", "literalpath", "include", "exclude", "filter", "stream", "erroraction", "warningaction", "informationaction", "progressaction", "credential"]);
  const flags = new Set(["force", "recurse", "whatif", "confirm", "verbose", "debug", "ea", "wa", "ev", "wv", "iv", "pv", "outvariable", "outbuffer", "pipelinevariable"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      const [rawKey, inline] = arg.slice(1).split(/:(.*)/s, 2);
      const key = (rawKey ?? "").toLowerCase();
      if (["r", "re", "rec", "recu", "recur", "recurs", "recurse"].includes(key)) recurse = true;
      else if (takesValue.has(key)) {
        const value = inline ?? args[++i];
        if (value === undefined) { unsupported = true; continue; }
        if (key === "path" || key === "literalpath") {
          const paths = value.split(",").filter(Boolean);
          targets += Math.max(1, paths.length);
          if (paths.some(isGlob)) glob = true;
        }
      } else if (!flags.has(key)) unsupported = true;
      continue;
    }
    const paths = arg.split(",").filter(Boolean);
    targets += Math.max(1, paths.length);
    if (paths.some(isGlob)) glob = true;
  }
  return recurse || targets >= 2 || glob ? MATCH("powershell-remove-tree") : unsupported ? UNSUPPORTED : NOT_MATCHED;
}
