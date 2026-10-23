/**
 * The Python path semantics workspace grants rely on: `os.path.expanduser`,
 * `str(PurePath(...))`, `Path.resolve(strict=True)`, `os.access`,
 * `os.path.ismount`, `tempfile.gettempdir`, `shutil.which`, `shlex.quote`
 * and `process_runtime.host_platform_family`.
 */
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { realish } from "@xueness/sessions";

export const WINDOWS = process.platform === "win32";

function passwdHome(name: string): string | null {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":");
      if (fields[0] === name && fields.length >= 7) return fields[5]!;
    }
  } catch { /* no password file */ }
  try { const me = userInfo(); return me.username === name ? me.homedir : null; } catch { return null; }
}

/** `os.path.expanduser` for the host flavour. */
export function expandUser(path: string): string {
  if (!path.startsWith("~")) return path;
  if (WINDOWS) {
    let end = 1;
    while (end < path.length && path[end] !== "/" && path[end] !== "\\") end += 1;
    const env = process.env;
    let home: string;
    if (env.USERPROFILE !== undefined) home = env.USERPROFILE;
    else if (env.HOMEPATH === undefined) return path;
    else home = join(env.HOMEDRIVE ?? "", env.HOMEPATH);
    if (end !== 1) {
      const target = path.slice(1, end);
      if (target !== env.USERNAME) {
        if (env.USERNAME !== basename(home)) return path;
        home = join(dirname(home), target);
      }
    }
    return home + path.slice(end);
  }
  const slash = path.indexOf("/", 1), end = slash < 0 ? path.length : slash;
  let home: string | null;
  if (end === 1) home = process.env.HOME ?? (() => { try { return userInfo().homedir; } catch { return null; } })();
  else home = passwdHome(path.slice(1, end));
  if (home === null) return path;
  return home.replace(/\/+$/u, "") + path.slice(end) || "/";
}

/** `str(PurePath(raw))`: separators collapsed, `.` parts and a trailing separator dropped, `..` kept. */
export function purePath(raw: string): string {
  if (WINDOWS) {
    const text = raw.replaceAll("/", "\\");
    const unc = /^\\\\[^\\]+\\[^\\]+/u.exec(text)?.[0] ?? "";
    const drive = unc || (/^[A-Za-z]:/u.exec(text)?.[0] ?? "");
    const rest = text.slice(drive.length);
    const root = rest.startsWith("\\") ? "\\" : "";
    const parts = rest.split("\\").filter((part) => part && part !== ".");
    return drive + root + parts.join("\\") || ".";
  }
  const root = raw.startsWith("//") && !raw.startsWith("///") ? "//" : raw.startsWith("/") ? "/" : "";
  const parts = raw.split("/").filter((part) => part && part !== ".");
  return root + parts.join("/") || ".";
}

/** `PurePath.is_absolute()`: a root, and on Windows a drive as well. */
export function isAbsolutePath(path: string): boolean {
  return WINDOWS ? /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)[\\/]/u.test(path) : path.startsWith("/");
}

/** `Path(raw).resolve(strict=True)`; throws when any component is missing. */
export function resolveStrict(path: string): string {
  return realpathSync.native(purePath(path));
}

/** `Path(raw).resolve()` (non-strict). */
export function resolveLoose(path: string): string {
  return realish(purePath(path));
}

export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** `os.access(path, os.W_OK | os.X_OK)`. */
export function writable(path: string): boolean {
  try { accessSync(path, constants.W_OK | constants.X_OK); return true; } catch { return false; }
}

/** `PurePath.name or str(path)`. */
export function label(path: string): string {
  return basename(path) || path;
}

/** `os.path.ismount`. */
export function isMount(path: string): boolean {
  if (WINDOWS) return /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)[\\/]?$/u.test(path);
  try {
    const self = lstatSync(path, { bigint: true });
    if (self.isSymbolicLink()) return false;
    const parent = lstatSync(realish(join(path, "..")), { bigint: true });
    return self.dev !== parent.dev || self.ino === parent.ino;
  } catch { return false; }
}

let temporary: string | undefined;
/** `tempfile.gettempdir()`: the first usable candidate, cached like Python's. */
export function tempDir(): string {
  if (temporary !== undefined) return temporary;
  const candidates = ["TMPDIR", "TEMP", "TMP"].map((name) => process.env[name]).filter((value): value is string => !!value);
  if (WINDOWS) candidates.push(join(homedir(), "AppData", "Local", "Temp"), join(process.env.SYSTEMROOT ?? "C:\\Windows", "Temp"), "c:\\temp", "c:\\tmp", "\\temp", "\\tmp");
  else candidates.push("/tmp", "/var/tmp", "/usr/tmp");
  candidates.push(process.cwd());
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (isDirectory(absolute) && writable(absolute)) return temporary = absolute;
  }
  throw new Error("No usable temporary directory found");
}

/** `shutil.which(name)` for a bare executable name. */
export function which(name: string): string | null {
  const path = process.env.PATH ?? (WINDOWS ? "" : "/bin:/usr/bin");
  if (!path) return null;
  const directories = [...new Set(path.split(delimiter))];
  if (WINDOWS) directories.unshift(".");
  for (const directory of directories) {
    const candidate = directory ? join(directory, name) : name;
    try {
      if (existsSync(candidate) && !statSync(candidate).isDirectory()) { accessSync(candidate, constants.X_OK); return candidate; }
    } catch { /* not executable here */ }
  }
  return null;
}

/** `shlex.quote`. */
export function shlexQuote(text: string): string {
  if (!text) return "''";
  if (!/[^\w@%+=:,./-]/u.test(text)) return text;
  return "'" + text.replaceAll("'", "'\"'\"'") + "'";
}

/** `host_platform_family(platform)`. */
export function platformFamily(raw: unknown = process.platform): string {
  if (typeof raw !== "string") return "unknown";
  const text = raw.trim().toLowerCase();
  if (!text) return "unknown";
  if (text === "darwin" || text.startsWith("mac")) return "macos";
  if (text.startsWith("win")) return "windows";
  if (text.startsWith("linux")) return "linux";
  return text;
}