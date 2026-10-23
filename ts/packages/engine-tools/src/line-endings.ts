/**
 * Line ending handling. Edits work on LF text; the file keeps its own line
 * endings. Bytes outside an edited region are never rewritten.
 */

export type LineEnding = "\n" | "\r\n";

/** CRLF when CRLF line breaks outnumber bare LF ones; LF otherwise. */
export function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? "\r\n" : "\n";
}

export function toLf(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export function withLineEnding(text: string, ending: LineEnding): string {
  const lf = toLf(text);
  return ending === "\n" ? lf : lf.replaceAll("\n", "\r\n");
}

/**
 * Maps offsets in the LF-normalised text back to the raw text. Normalising
 * removes the `\r` of each CRLF; the map counts those removals.
 */
export class LfOffsetMap {
  readonly #removed: number[] = [];

  constructor(raw: string) {
    let removed = 0;
    for (let index = raw.indexOf("\r\n"); index >= 0; index = raw.indexOf("\r\n", index + 2)) {
      // Position of the `\n` in normalised coordinates.
      this.#removed.push(index - removed);
      removed += 1;
    }
  }

  /** Raw offset for a normalised offset; a CRLF break maps to its `\r`. */
  toRaw(offset: number): number {
    let low = 0;
    let high = this.#removed.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.#removed[mid] as number) < offset) low = mid + 1;
      else high = mid;
    }
    return offset + low;
  }
}
