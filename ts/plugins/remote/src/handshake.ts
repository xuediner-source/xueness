/**
 * Port of `bundled_plugins/remote/handshake.py`.
 * `general.remoteHandshakeEnabled` is on only when that settings value is boolean true.
 * Anything else (missing file, corrupt JSON, string "true", 1) leaves the probe off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonLoads, pyStrip, pySubstring } from "@xueness/contracts";

export const FEATURE_ID = "remote.handshake";
export const SETTINGS_KEY = "remoteHandshakeEnabled";
export const SCHEMA = "xueness.remote-handshake.v1";
export const PROTOCOL = 1;
export const PROBE_TIMEOUT_SECONDS = 15;
export const MAX_PARSE_CHARS = 65536;
export const MAX_PREAMBLE_LINES = 32;
export const MAX_DIAGNOSTIC_CHARS = 2048;
const DIAGNOSTIC_SCAN = 65536;

export const BEGIN = "xueness-hello-begin";
export const END = "xueness-hello-end";

/** Fixed remote script. No operator argv, directory, host, or user is inserted. */
export const PROBE_COMMAND = (
  "printf '%s\\n' xueness-hello-begin\n"
  + "uname -s\n"
  + "uname -m\n"
  + "xueness_kernel_ostype=$(cat /proc/sys/kernel/ostype || true)\n"
  + "printf '%s\\n' \"$xueness_kernel_ostype\"\n"
  + "printf '%s\\n' xueness-hello-end\n"
);

const FIELD = /^[A-Za-z0-9._+/-]{0,64}$/;
// CSI, OSC, and single-character ESC. Same shape as handshake.py `_ANSI`.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

const TRANSPORT: readonly { code: string; retryable: boolean; message: string; needles: readonly string[] }[] = [
  { code: "ssh_host_key", retryable: false, message: "SSH host key verification failed", needles: ["host key verification failed", "remote host identification has changed"] },
  { code: "ssh_auth", retryable: false, message: "SSH authentication failed", needles: ["permission denied", "authentication failed", "too many authentication failures"] },
  { code: "ssh_timeout", retryable: true, message: "SSH connection timed out", needles: ["connection timed out", "operation timed out"] },
  { code: "ssh_unavailable", retryable: true, message: "SSH connection failed", needles: ["connection refused", "connection closed", "could not resolve", "name or service not known", "no route to host", "network is unreachable", "connection reset"] },
];

export type Row = Record<string, unknown>;

export interface HelloRaw {
  platform: string;
  arch: string;
  kernel: string;
}

export interface HelloView {
  schema: string;
  protocol: number;
  platform: string;
  reportedPlatform: string;
  arch: string;
  reportedArch: string;
  kernel: string;
  shell: "posix" | "unsupported";
  capabilities: string[];
  accepted: boolean;
  platformCorrected: boolean;
}

export type HandshakeDecision = { accepted: true; hello: HelloView } | { accepted: false; result: Row };

/** True only for boolean true in `<stateDir>/settings.json`. */
export function enabled(stateDir: string): boolean {
  try {
    if (typeof stateDir !== "string" || !stateDir) return false;
    const value = pyJsonLoads(readFileSync(join(stateDir, "settings.json"), "utf8"));
    if (!isDict(value)) return false;
    const section = value.general;
    return isDict(section) && section[SETTINGS_KEY] === true;
  } catch {
    return false;
  }
}

export function normalizePlatform(raw: string): string {
  const platform = pyStrip(raw).toLowerCase();
  if (platform === "darwin" || platform === "macos") return "darwin";
  if (platform === "linux" || platform === "gnu/linux") return "linux";
  if (platform === "windows_nt" || platform.startsWith("mingw") || platform.startsWith("msys") || platform.startsWith("cygwin")) return "win32";
  return platform;
}

export function normalizeArch(raw: string): string {
  const arch = pyStrip(raw).toLowerCase();
  if (arch === "x86_64" || arch === "amd64") return "x64";
  if (arch === "aarch64" || arch === "arm64e") return "arm64";
  return arch;
}

function cleaned(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) === 0x0d) end -= 1;
  return pyStrip(line.slice(0, end));
}

function matchesField(value: string): boolean {
  // JS `$` matches before a final newline; the field charset must not.
  return !value.includes("\n") && !value.includes("\r") && FIELD.test(value);
}

/** Three probe fields, or null when the frame is not usable. */
export function parseHello(stdout: unknown): HelloRaw | null {
  if (typeof stdout !== "string" || !stdout) return null;
  const text = pySubstring(stdout, 0, MAX_PARSE_CHARS);
  if (text.includes("\0")) return null;
  const lines = text.split("\n");
  let beginAt: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (cleaned(lines[index] ?? "") === BEGIN) {
      beginAt = index;
      break;
    }
    if (index + 1 >= MAX_PREAMBLE_LINES) return null;
  }
  if (beginAt === null) return null;
  const body = lines.slice(beginAt + 1, beginAt + 5);
  if (body.length < 4 || cleaned(body[3] ?? "") !== END) return null;
  const platform = cleaned(body[0] ?? "");
  const arch = cleaned(body[1] ?? "");
  const kernel = cleaned(body[2] ?? "");
  if (!platform || !arch) return null;
  if (!matchesField(platform) || !matchesField(arch) || !matchesField(kernel)) return null;
  return { platform, arch, kernel };
}

/** Normalize one parsed hello into the capability report. */
export function negotiate(raw: HelloRaw): HelloView {
  const reported = normalizePlatform(raw.platform);
  const kernel = raw.kernel ? normalizePlatform(raw.kernel) : "";
  let platform = reported;
  let corrected = false;
  if (reported === "darwin" && kernel === "linux") {
    platform = "linux";
    corrected = true;
  }
  const windows = platform === "win32";
  return {
    schema: SCHEMA,
    protocol: PROTOCOL,
    platform,
    reportedPlatform: reported,
    arch: normalizeArch(raw.arch),
    reportedArch: raw.arch,
    kernel,
    shell: windows ? "unsupported" : "posix",
    capabilities: windows ? [] : ["posix-shell"],
    accepted: !windows,
    platformCorrected: corrected,
  };
}

function exitCodeOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Python `str.isprintable` for one code point: not Other/Separator, except ASCII space. */
function isPrintable(char: string): boolean {
  if (char === " ") return true;
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return !/[\p{C}\p{Z}]/u.test(char);
}

/** Keep the tail of a diagnostic and drop terminal control characters. */
export function boundText(value: unknown, limit = MAX_DIAGNOSTIC_CHARS): string {
  if (typeof value !== "string" || !value) return "";
  ANSI.lastIndex = 0;
  const stripped = pySubstring(value, -DIAGNOSTIC_SCAN).replace(ANSI, "");
  let cleaned = "";
  for (const char of stripped) {
    if (char === "\n" || char === "\t" || (char !== "\r" && isPrintable(char))) cleaned += char;
  }
  return pySubstring(cleaned, -limit);
}

export function diagnostics(exitCode: unknown, stdout: unknown, stderr: unknown): Row {
  return { exitCode: exitCodeOf(exitCode), stdout: boundText(stdout), stderr: boundText(stderr) };
}

function windowsMessage(view: HelloView): string {
  const reported = view.reportedPlatform || view.platform || "win32";
  return `remote Windows hosts are not supported (probed platform=${reported}): commands are quoted for a POSIX shell and cannot be run safely on cmd or PowerShell`;
}

function rejected(code: string, message: string, retryable: boolean, exitCode: unknown, stdout: unknown, stderr: unknown, view: HelloView | null): { accepted: false; result: Row } {
  const codeValue = exitCodeOf(exitCode);
  return {
    accepted: false,
    result: {
      ok: false,
      executed: false,
      exit_code: codeValue,
      error: message,
      error_code: code,
      feature: FEATURE_ID,
      handshake: view,
      failure: { code, message, retryable },
      diagnostics: diagnostics(codeValue, stdout, stderr),
    },
  };
}

/** Shared with the port-forward lifecycle: the same ssh failure needles. */
export function classifyTransport(stderr: unknown): { code: string; retryable: boolean; message: string } | null {
  if (typeof stderr !== "string" || !stderr) return null;
  const sample = pySubstring(stderr, -DIAGNOSTIC_SCAN).toLowerCase();
  for (const item of TRANSPORT) {
    if (item.needles.some((needle) => sample.includes(needle))) return item;
  }
  return null;
}

/** Accept a POSIX probe, or the tool result that refuses the command. */
export function decide(returncode: unknown, stdout: unknown, stderr: unknown): HandshakeDecision {
  const hello = parseHello(stdout);
  const view = hello ? negotiate(hello) : null;
  if (view?.platform === "win32") return rejected("capability_unsupported", windowsMessage(view), false, returncode, stdout, stderr, view);
  if (view && returncode === 0) return { accepted: true, hello: view };
  const kind = classifyTransport(stderr);
  if (kind) return rejected(kind.code, kind.message, kind.retryable, returncode, stdout, stderr, view);
  if (!view && returncode === 0) {
    return rejected("handshake_invalid", "remote handshake did not report a usable capability", false, returncode, stdout, stderr, null);
  }
  return rejected("handshake_closed", "remote handshake closed before a capability report", returncode === 255, returncode, stdout, stderr, view);
}

/** Probe timed out. The message does not include the ssh argv. */
export function timeoutResult(exc: { stdout?: unknown; stderr?: unknown } | null | undefined): Row {
  return rejected("ssh_timeout", "SSH connection timed out", true, null, exc?.stdout, exc?.stderr, null).result;
}

/** The operator command was sent and the local wait expired. */
export function commandTimeoutResult(exc: { stdout?: unknown; stderr?: unknown } | null | undefined, hello: unknown): Row {
  const stdout = textOf(exc?.stdout);
  const stderr = textOf(exc?.stderr);
  const message = "remote command timed out";
  return {
    ok: false,
    executed: true,
    exit_code: null,
    output: pySubstring(stdout + stderr, 0, 16_000),
    error: message,
    error_code: "command_timeout",
    feature: FEATURE_ID,
    handshake: hello ?? null,
    failure: { code: "command_timeout", message, retryable: true },
    diagnostics: diagnostics(null, stdout, stderr),
  };
}

export function clientUnavailableResult(): Row {
  return rejected("ssh_unavailable", "ssh client unavailable", false, null, "", "", null).result;
}

export function cliLocalFailure(result: unknown): boolean {
  if (!isDict(result) || result.feature !== FEATURE_ID) return false;
  if (result.executed === false) return true;
  return result.error_code === "command_timeout";
}

export function cliPayload(result: unknown): Row {
  const row = isDict(result) ? result : {};
  return {
    error: row.error ?? null,
    error_code: row.error_code ?? null,
    failure: row.failure ?? null,
    handshake: row.handshake ?? null,
    diagnostics: row.diagnostics ?? null,
    executed: row.executed ?? null,
    feature: row.feature ?? null,
  };
}
