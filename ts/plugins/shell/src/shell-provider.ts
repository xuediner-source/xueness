import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { basename, delimiter, join, win32 } from "node:path";

export type ShellDialect = "posix" | "powershell" | "cmd";

export interface BashShellProvider {
  dialect: "posix";
  executable: string;
  envOverlay: NodeJS.ProcessEnv;
}

export function resolveBashShell(
  executableOverride: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isExecutable,
): BashShellProvider | undefined {
  const override = executableOverride.trim();
  if (override) {
    const executable = resolveExecutable(override, env, platform, exists);
    if (!executable || (platform === "win32" && isWindowsAppsPath(executable))) return undefined;
    return makeProvider(executable);
  }

  const executable = platform === "win32"
    ? resolveWindowsGitBash(env, exists)
    : resolvePosixBash(env, exists);
  return executable ? makeProvider(executable) : undefined;
}

function makeProvider(executable: string): BashShellProvider {
  return { dialect: "posix", executable, envOverlay: { GIT_EDITOR: "true", SHELL: executable } };
}

function resolvePosixBash(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  const candidates: string[] = [];
  if (env.SHELL && basename(env.SHELL) === "bash") candidates.push(env.SHELL);
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(join(directory, "bash"));
  candidates.push("/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash");
  return unique(candidates).find(exists);
}

function resolveWindowsGitBash(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  const candidates: string[] = [];
  const programFiles = [getEnv(env, "ProgramW6432"), getEnv(env, "ProgramFiles"), getEnv(env, "ProgramFiles(x86)")].filter((value): value is string => Boolean(value));
  for (const root of unique(programFiles)) candidates.push(win32.join(root, "Git", "bin", "bash.exe"));

  // Only search PATH entries that point into Git for Windows; WindowsApps\bash.exe
  // can be the WSL app-execution alias and must never be selected implicitly.
  const pathValue = getEnv(env, "PATH") ?? "";
  for (const directory of pathValue.split(win32.delimiter).filter(Boolean)) {
    if (isWindowsAppsPath(directory)) continue;
    if (/\\git(?:\\|$)/i.test(`${directory}\\`)) candidates.push(win32.join(directory, "bash.exe"));
  }

  // Git's command-line install may expose git.exe under Git\cmd or Git\bin.
  for (const directory of pathValue.split(win32.delimiter).filter(Boolean)) {
    if (!/\\git\\(?:cmd|bin)\\?$/i.test(directory)) continue;
    const gitRoot = win32.resolve(directory, "..");
    candidates.push(win32.join(gitRoot, "bin", "bash.exe"));
  }
  return unique(candidates).find((candidate) => !isWindowsAppsPath(candidate) && exists(candidate));
}

function resolveExecutable(value: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (path: string) => boolean): string | undefined {
  if (platform !== "win32") {
    if (value.includes("/") && exists(value)) return value;
    return (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, value)).find(exists);
  }

  const normalized = value.replaceAll("/", "\\");
  const hasDirectory = normalized.includes("\\") || win32.isAbsolute(normalized);
  const names = /\.exe$/i.test(normalized) ? [normalized] : [`${normalized}.exe`];
  const candidates = hasDirectory
    ? names.map((name) => win32.isAbsolute(name) ? win32.normalize(name) : win32.resolve(name))
    : (getEnv(env, "PATH") ?? "").split(win32.delimiter).filter(Boolean).flatMap((directory) => names.map((name) => win32.join(directory, name)));
  return candidates.find((candidate) => !isWindowsAppsPath(candidate) && exists(candidate));
}

function isExecutable(path: string): boolean {
  if (process.platform === "win32") return existsSync(path);
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function isWindowsAppsPath(path: string): boolean {
  return /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(path);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
