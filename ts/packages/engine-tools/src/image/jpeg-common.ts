/** Tables shared by the JPEG decoder and encoder (ITU T.81). */

/** Natural (row-major) index of each zigzag position. */
export const ZIGZAG: Int32Array = (() => {
  const order = new Int32Array(64);
  let index = 0;
  for (let sum = 0; sum < 15; sum += 1) {
    const cells: number[] = [];
    for (let row = 0; row < 8; row += 1) { const col = sum - row; if (col >= 0 && col < 8) cells.push(row * 8 + col); }
    // Even diagonals run bottom-left to top-right.
    if (sum % 2 === 0) cells.reverse();
    for (const cell of cells) order[index++] = cell;
  }
  return order;
})();

/** `COS[x * 8 + u]` = C(u) · cos((2x + 1)uπ / 16) / 2, the 1-D DCT basis. */
export const COS: Float64Array = (() => {
  const table = new Float64Array(64);
  for (let x = 0; x < 8; x += 1) {
    for (let u = 0; u < 8; u += 1) table[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2;
  }
  return table;
})();

/** Inverse 8×8 DCT of dequantized natural-order coefficients into level-shifted samples. */
export function inverseDct(input: Float64Array, output: Uint8Array, outOffset: number, stride: number, scratch: Float64Array): void {
  for (let u = 0; u < 8; u += 1) {
    // Columns: when every AC term is zero the column is flat.
    let flat = true;
    for (let v = 1; v < 8; v += 1) if (input[v * 8 + u] !== 0) { flat = false; break; }
    if (flat) {
      const value = input[u]! * COS[0]!;
      for (let y = 0; y < 8; y += 1) scratch[y * 8 + u] = value;
      continue;
    }
    for (let y = 0; y < 8; y += 1) {
      let sum = 0;
      for (let v = 0; v < 8; v += 1) sum += COS[y * 8 + v]! * input[v * 8 + u]!;
      scratch[y * 8 + u] = sum;
    }
  }
  for (let y = 0; y < 8; y += 1) {
    const row = y * 8, out = outOffset + y * stride;
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let u = 0; u < 8; u += 1) sum += COS[x * 8 + u]! * scratch[row + u]!;
      const value = Math.round(sum + 128);
      output[out + x] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
  }
}

/** Forward 8×8 DCT of level-shifted samples (natural order). */
export function forwardDct(input: Float64Array, output: Float64Array, scratch: Float64Array): void {
  for (let y = 0; y < 8; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let x = 0; x < 8; x += 1) sum += COS[x * 8 + u]! * input[y * 8 + x]!;
      scratch[y * 8 + u] = sum;
    }
  }
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) sum += COS[y * 8 + v]! * scratch[y * 8 + u]!;
      output[v * 8 + u] = sum;
    }
  }
}
