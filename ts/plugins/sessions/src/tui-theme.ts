import type { TuiThemeMode } from './tui-types.ts';

export interface TuiPalette {
  accent: string;
  dim: string;
  error: string;
  success: string;
  warning: string;
  border: string;
  reset: string;
  bold: string;
  code: string;
  add: string;
  remove: string;
  background: string;
  foreground: string;
}

const rgb = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number): string => `\x1b[48;2;${r};${g};${b}m`;

export function palette(mode: TuiThemeMode): TuiPalette {
  const dark = mode === 'dark';
  return {
    accent: rgb(...(dark ? [56, 189, 248] : [3, 105, 161]) as [number, number, number]),
    dim: rgb(...(dark ? [148, 163, 184] : [71, 85, 105]) as [number, number, number]),
    error: rgb(...(dark ? [252, 165, 165] : [185, 28, 28]) as [number, number, number]),
    success: rgb(...(dark ? [134, 239, 172] : [21, 128, 61]) as [number, number, number]),
    warning: rgb(...(dark ? [251, 191, 36] : [161, 98, 7]) as [number, number, number]),
    border: rgb(...(dark ? [71, 85, 105] : [148, 163, 184]) as [number, number, number]),
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    code: rgb(...(dark ? [134, 239, 172] : [21, 128, 61]) as [number, number, number]),
    add: rgb(...(dark ? [134, 239, 172] : [22, 101, 52]) as [number, number, number]),
    remove: rgb(...(dark ? [252, 165, 165] : [153, 27, 27]) as [number, number, number]),
    background: bg(...(dark ? [15, 20, 25] : [248, 250, 252]) as [number, number, number]),
    foreground: rgb(...(dark ? [229, 231, 235] : [17, 24, 39]) as [number, number, number]),
  };
}

export function resolveTheme(preference: 'auto' | TuiThemeMode, detected?: TuiThemeMode): TuiThemeMode {
  if (preference !== 'auto') return preference;
  return detected ?? 'dark';
}

export function parseTerminalTheme(reply: string): TuiThemeMode | undefined {
  const match = /(?:\x1b\])?11;rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})(?:\x07|\x1b\\|$)/i.exec(reply.trim());
  if (!match) return undefined;
  const channels = match.slice(1, 4).map((part) => parseInt(part, 16) / (16 ** part.length - 1));
  const [r, g, b] = channels;
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return luminance > 0.5 ? 'light' : 'dark';
}
