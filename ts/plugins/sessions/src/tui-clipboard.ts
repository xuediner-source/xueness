import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

const IMAGE_LIMIT = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COMMAND_TIMEOUT_MS = 8_000;

type ProcessOptions = {
  input?: string | Buffer;
  stdoutLimit: number;
  outputTooLargeMessage?: string;
};

export async function readClipboardPng(): Promise<Buffer | null> {
  if (process.platform === 'win32') return readWindowsPng();
  if (process.platform === 'darwin') return readMacPng();
  if (process.platform === 'linux') return readLinuxPng();
  throw new Error(`Clipboard access is unsupported on ${process.platform}`);
}

export async function writeClipboardText(text: string): Promise<void> {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$text = [Console]::In.ReadToEnd()',
      'Set-Clipboard -Value $text',
    ].join('; ');
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      input: text,
      stdoutLimit: 16 * 1024,
    });
    return;
  }
  if (process.platform === 'darwin') {
    await runProcess('pbcopy', [], { input: text, stdoutLimit: 16 * 1024 });
    return;
  }
  if (process.platform === 'linux') {
    const wlCopy = await findOnPath('wl-copy');
    if (wlCopy) {
      await runProcess(wlCopy, [], { input: text, stdoutLimit: 16 * 1024 });
      return;
    }
    const xclip = await findOnPath('xclip');
    if (!xclip) throw new Error('Clipboard command unavailable (wl-copy or xclip)');
    await runProcess(xclip, ['-selection', 'clipboard', '-i', '-t', 'UTF8_STRING'], {
      input: text,
      stdoutLimit: 16 * 1024,
    });
    return;
  }
  throw new Error(`Clipboard access is unsupported on ${process.platform}`);
}

async function readWindowsPng(): Promise<Buffer | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -ne $image) {',
    '  $stream = New-Object System.IO.MemoryStream',
    '  try { $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray())) }',
    '  finally { $stream.Dispose(); $image.Dispose() }',
    '}',
  ].join(' ');
  const encoded = (await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
    stdoutLimit: Math.ceil(IMAGE_LIMIT / 3) * 4 + 8,
    outputTooLargeMessage: 'Clipboard image exceeds 2 MiB',
  })).toString('ascii').trim();
  if (!encoded) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Clipboard image response was invalid');
  }
  return validatePng(Buffer.from(encoded, 'base64'));
}

async function readMacPng(): Promise<Buffer | null> {
  const directory = await mkdtemp(join(tmpdir(), 'xueness-clipboard-'));
  const file = join(directory, 'clipboard.png');
  const script = [
    'try',
    '  set pngData to (the clipboard as «class PNGf»)',
    'on error',
    '  return "no-image"',
    'end try',
    `set outputFile to open for access POSIX file ${appleScriptString(file)} with write permission`,
    'try',
    '  set eof outputFile to 0',
    '  write pngData to outputFile',
    'on error errMsg number errNum',
    '  close access outputFile',
    '  error errMsg number errNum',
    'end try',
    'close access outputFile',
    'return "ok"',
  ].join('\n');
  try {
    const status = (await runProcess('osascript', ['-e', script], { stdoutLimit: 1024 })).toString('utf8').trim();
    if (status === 'no-image') return null;
    if (status !== 'ok') throw new Error('Clipboard image response was invalid');
    const metadata = await stat(file);
    if (metadata.size > IMAGE_LIMIT) throw new Error('Clipboard image exceeds 2 MiB');
    return validatePng(await readFile(file));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readLinuxPng(): Promise<Buffer | null> {
  const wlPaste = await findOnPath('wl-paste');
  if (wlPaste) {
    const types = await runProcess(wlPaste, ['--list-types'], { stdoutLimit: 64 * 1024 });
    if (!hasPngType(types)) return null;
    const png = await runProcess(wlPaste, ['--type', 'image/png'], imageReadOptions());
    return validatePng(png);
  }

  const xclip = await findOnPath('xclip');
  if (!xclip) throw new Error('Clipboard command unavailable (wl-paste or xclip)');
  const targets = await runProcess(xclip, ['-selection', 'clipboard', '-o', '-t', 'TARGETS'], { stdoutLimit: 64 * 1024 });
  if (!hasPngType(targets)) return null;
  const png = await runProcess(xclip, ['-selection', 'clipboard', '-t', 'image/png', '-o'], imageReadOptions());
  return validatePng(png);
}

function imageReadOptions(): ProcessOptions {
  return { stdoutLimit: IMAGE_LIMIT + 1, outputTooLargeMessage: 'Clipboard image exceeds 2 MiB' };
}

function validatePng(image: Buffer): Buffer | null {
  if (image.length === 0) return null;
  if (image.length > IMAGE_LIMIT) throw new Error('Clipboard image exceeds 2 MiB');
  if (image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Clipboard image is not a PNG');
  }
  return image;
}

function hasPngType(output: Buffer): boolean {
  return output.toString('utf8').split(/\r?\n/).some((type) => type.trim().toLowerCase() === 'image/png');
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function findOnPath(command: string): Promise<string | undefined> {
  const entries = (process.env.PATH ?? '').split(delimiter);
  for (const entry of entries) {
    const candidate = join(entry || process.cwd(), command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH entries; command lookup errors do not include user data.
    }
  }
  return undefined;
}

function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let outputSize = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, output?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(output ?? Buffer.alloc(0));
    };

    timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Clipboard command timed out (${command})`));
    }, COMMAND_TIMEOUT_MS);

    child.once('error', () => finish(new Error(`Clipboard command could not start (${command})`)));
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > options.stdoutLimit) {
        child.kill();
        finish(new Error(options.outputTooLargeMessage ?? `Clipboard command output exceeded limit (${command})`));
        return;
      }
      chunks.push(chunk);
    });
    child.stdin.on('error', () => undefined);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(`Clipboard command failed (${command}, ${signal ?? `exit ${code}`})`));
        return;
      }
      finish(undefined, Buffer.concat(chunks, outputSize));
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
