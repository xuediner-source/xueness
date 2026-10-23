/** Fixed shell profiles. Arbitrary command text is never accepted as a shell. */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join, basename } from "node:path";

const POSIX = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].flatMap((dir) => ["sh", "bash", "zsh", "fish"].map((name) => join(dir, name)));

function executable(path: string): string | null {
  try {
    const real = realpathSync(path);
    if (!statSync(real).isFile()) return null;
    accessSync(real, constants.X_OK);
    return real;
  } catch { return null; }
}

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const found = executable(join(dir, name));
    if (found) return found;
  }
  return null;
}

export function shellPaths(): readonly string[] {
  if (process.platform === "win32") return [...new Set([which("pwsh.exe"), which("powershell.exe"), which("cmd.exe")].filter((item): item is string => item !== null))];
  return POSIX.map((path) => executable(path)).filter((item): item is string => item !== null);
}

export function availableShells(): { id: string; label: string }[] {
  return shellPaths().map((path) => ({ id: path, label: `${basename(path)} (${path})` }));
}

export function resolveShell(profile?: unknown): string {
  const paths = shellPaths();
  const chosen = typeof profile === "string" && profile ? profile : (paths[0] ?? (process.platform === "win32" ? "" : "/bin/sh"));
  if (!paths.includes(chosen)) {
    const error = new Error("terminal shell profile is unavailable");
    error.name = "ValueError";
    throw error;
  }
  return chosen;
}
