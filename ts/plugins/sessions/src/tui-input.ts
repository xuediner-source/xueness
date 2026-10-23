import { StringDecoder } from 'node:string_decoder';
import { PassThrough } from 'node:stream';
import { emitKeypressEvents, type Key } from 'node:readline';
import { parseTerminalTheme } from './tui-theme.ts';

export interface TuiMouse {
  x: number;
  y: number;
  button: number;
  release: boolean;
  motion: boolean;
  wheel: -1 | 0 | 1;
}

type Callbacks = {
  key(text: string | undefined, key: Key): void;
  mouse(event: TuiMouse): void;
  theme(mode: 'dark' | 'light'): void;
};

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const OSC_THEME_PREFIX = '11;rgb:';

type EscapeResult =
  | { kind: 'text'; length: number }
  | { kind: 'wait'; ambiguous: boolean }
  | { kind: 'paste'; length: number }
  | { kind: 'mouse'; length: number; event: TuiMouse }
  | { kind: 'key'; length: number; text: string | undefined; key: Key }
  | { kind: 'theme'; length: number; mode: 'dark' | 'light' };

const ENTER_KEYS: readonly { sequence: string; key: Key }[] = [
  { sequence: `${ESC}[13;2u`, key: { name: 'return', shift: true, ctrl: false, meta: false } },
  { sequence: `${ESC}[13;5u`, key: { name: 'return', shift: false, ctrl: true, meta: false } },
  { sequence: `${ESC}[27;2;13~`, key: { name: 'return', shift: true, ctrl: false, meta: false } },
  { sequence: `${ESC}[27;5;13~`, key: { name: 'return', shift: false, ctrl: true, meta: false } },
];

export class TuiInputDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private readonly input = new PassThrough();
  private readonly onKeypress = (text: string | undefined, key: Key): void => this.callbacks.key(text, key);
  private pending = '';
  private paste = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  private readonly callbacks: Callbacks;
  constructor(callbacks: Callbacks) {
    this.callbacks = callbacks;
    emitKeypressEvents(this.input);
    this.input.on('keypress', this.onKeypress);
  }

  write(chunk: Buffer | string): void {
    if (this.closed) return;
    this.clearTimer();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.pending += this.decoder.write(bytes);
    this.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.pending += this.decoder.end();
    this.drain();
    if (this.pending) {
      this.input.write(this.pending);
      this.pending = '';
    }
    this.input.removeListener('keypress', this.onKeypress);
    this.input.end();
  }

  private drain(): void {
    let ambiguous = false;
    while (this.pending) {
      if (this.paste) {
        const end = this.pending.indexOf(PASTE_END);
        if (end >= 0) {
          const length = end + PASTE_END.length;
          this.input.write(this.pending.slice(0, length));
          this.pending = this.pending.slice(length);
          this.paste = false;
          continue;
        }
        const keep = suffixPrefixLength(this.pending, PASTE_END);
        const flush = this.pending.length - keep;
        if (flush) {
          this.input.write(this.pending.slice(0, flush));
          this.pending = this.pending.slice(flush);
        }
        break;
      }

      const escapeAt = this.pending.indexOf(ESC);
      if (escapeAt < 0) {
        this.input.write(this.pending);
        this.pending = '';
        break;
      }
      if (escapeAt > 0) {
        this.input.write(this.pending.slice(0, escapeAt));
        this.pending = this.pending.slice(escapeAt);
        continue;
      }

      const result = this.readEscape();
      if (result.kind === 'wait') {
        ambiguous = result.ambiguous;
        break;
      }
      if (result.kind === 'text') {
        this.input.write(this.pending.slice(0, result.length));
        this.pending = this.pending.slice(result.length);
        continue;
      }
      if (result.kind === 'paste') {
        this.input.write(this.pending.slice(0, result.length));
        this.pending = this.pending.slice(result.length);
        this.paste = true;
        continue;
      }
      if (result.kind === 'mouse') this.callbacks.mouse(result.event);
      else if (result.kind === 'theme') this.callbacks.theme(result.mode);
      else this.callbacks.key(result.text, { ...result.key, sequence: this.pending.slice(0, result.length) });
      this.pending = this.pending.slice(result.length);
    }
    if (ambiguous && !this.closed) this.armTimer();
    else this.clearTimer();
  }

  private readEscape(): EscapeResult {
    if (this.pending.length === 1) return { kind: 'wait', ambiguous: true };
    const next = this.pending[1];
    if (next === '[') return this.readCsi();
    if (next === ']') return this.readOsc();
    return { kind: 'text', length: 2 };
  }

  private readCsi(): EscapeResult {
    if (this.pending.startsWith(PASTE_START)) return { kind: 'paste', length: PASTE_START.length };
    if (PASTE_START.startsWith(this.pending)) return { kind: 'wait', ambiguous: true };

    for (const enter of ENTER_KEYS) {
      if (this.pending.startsWith(enter.sequence)) return { kind: 'key', length: enter.sequence.length, text: undefined, key: enter.key };
      if (enter.sequence.startsWith(this.pending)) return { kind: 'wait', ambiguous: true };
    }

    if (this.pending.startsWith(`${ESC}[<`)) {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
      if (mouse) {
        const rawButton = Number(mouse[1]);
        const x = Math.max(0, Number(mouse[2]) - 1);
        const y = Math.max(0, Number(mouse[3]) - 1);
        const wheelBit = (rawButton & 64) !== 0;
        const result: TuiMouse = {
          x,
          y,
          button: rawButton & 3,
          release: mouse[4] === 'm',
          motion: (rawButton & 32) !== 0,
          wheel: wheelBit ? ((rawButton & 3) === 0 ? -1 : 1) : 0,
        };
        return { kind: 'mouse', length: mouse[0].length, event: result };
      }
      const sgrPartial = /^\x1b\[<\d*(?:;\d*){0,2}$/.test(this.pending);
      if (sgrPartial && this.pending.length <= 128) return { kind: 'wait', ambiguous: false };
    }

    for (let i = 2; i < this.pending.length; i += 1) {
      const code = this.pending.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return { kind: 'text', length: i + 1 };
      if (code === 0x1b) return { kind: 'text', length: i };
      if (code < 0x20 || code > 0x3f) return { kind: 'text', length: i + 1 };
    }
    if (this.pending.length > 128) return { kind: 'text', length: this.pending.length };
    return { kind: 'wait', ambiguous: true };
  }

  private readOsc(): EscapeResult {
    const payload = this.pending.slice(2);
    const isThemePrefix = OSC_THEME_PREFIX.startsWith(payload);
    const isTheme = payload.startsWith(OSC_THEME_PREFIX);
    if (isThemePrefix && !isTheme) {
      return { kind: 'wait', ambiguous: !payload.startsWith('11;') };
    }

    const terminator = oscTerminatorEnd(this.pending);
    if (terminator < 0) {
      return { kind: 'wait', ambiguous: false };
    }
    const sequence = this.pending.slice(0, terminator);
    if (isTheme) {
      const mode = parseTerminalTheme(sequence);
      if (mode) return { kind: 'theme', length: terminator, mode };
    }
    return { kind: 'text', length: terminator };
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed && this.pending) {
        this.input.write(this.pending);
        this.pending = '';
      }
    }, 25);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function oscTerminatorEnd(value: string): number {
  for (let i = 2; i < value.length; i += 1) {
    if (value[i] === '\x07') return i + 1;
    if (value[i] === ESC && value[i + 1] === '\\') return i + 2;
  }
  return -1;
}

function suffixPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}
