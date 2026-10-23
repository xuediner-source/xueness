/**
 * Read's pure-TS image codecs and model image budget (ZCode v3.15.1
 * `prepareJimpImageForModel`). Decoders are checked against Pillow's decode
 * of the same tiny files (fixtures/images.ts); encoders by round trip.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeGif } from "../src/image/gif.ts";
import { encodeGif } from "../src/image/gif-encode.ts";
import { decodeJpeg } from "../src/image/jpeg-decode.ts";
import { AC_CHROMA_VALUES, AC_LUMA_VALUES, encodeJpeg } from "../src/image/jpeg-encode.ts";
import { decodePng, encodePng } from "../src/image/png.ts";
import { fitsImageBudget, ImagePrepareError, prepareImageForModel } from "../src/image/prepare.ts";
import { prepareImage } from "../src/image/prepare-async.ts";
import { createRaster, fitWithin, orient, type Raster } from "../src/image/raster.ts";
import { IMAGE_FIXTURES } from "./fixtures/images.ts";

function psnr(left: Uint8Array, right: Uint8Array): number {
  let error = 0;
  for (let i = 0; i < left.length; i += 1) error += (left[i]! - right[i]!) ** 2;
  return error === 0 ? Infinity : 10 * Math.log10((255 * 255) / (error / left.length));
}

function pattern(width: number, height: number, alpha = (_x: number, _y: number) => 255, noise = false, noiseMax = 255): Raster {
  const raster = createRaster(width, height);
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      if (noise) { for (let c = 0; c < 3; c += 1) { seed = (seed * 1103515245 + 12345) >>> 0; raster.data[at + c] = ((seed >>> 24) * noiseMax) / 255; } }
      else { raster.data[at] = (x * 255) / width; raster.data[at + 1] = (y * 255) / height; raster.data[at + 2] = 128 + 60 * Math.sin((x + y) / 9); }
      raster.data[at + 3] = alpha(x, y);
    }
  }
  return raster;
}

test("decoders match Pillow on baseline, progressive, subsampled, CMYK, restart, EXIF, PNG and GIF variants", () => {
  for (const fixture of IMAGE_FIXTURES) {
    const data = Buffer.from(fixture.file, "base64"), want = Buffer.from(fixture.rgba, "base64");
    let raster: Raster;
    if (fixture.kind === "jpeg") {
      const decoded = decodeJpeg(data);
      assert.equal(decoded.orientation, fixture.orientation, fixture.name);
      raster = orient(decoded.raster, decoded.orientation);
    } else raster = fixture.kind === "png" ? decodePng(data) : decodeGif(data);
    assert.deepEqual([raster.width, raster.height], [fixture.width, fixture.height], fixture.name);
    if (typeof fixture.tolerance === "number") assert.ok(psnr(raster.data, want) >= fixture.tolerance, `${fixture.name}: ${psnr(raster.data, want).toFixed(1)} dB`);
    else if (fixture.tolerance === "exact") assert.deepEqual(Buffer.from(raster.data), want, fixture.name);
    else {
      for (let at = 0; at < want.length; at += 4) {
        if (want[at + 3] === 0) assert.equal(raster.data[at + 3], 0, fixture.name);
        else assert.deepEqual([...raster.data.subarray(at, at + 4)], [...want.subarray(at, at + 4)], fixture.name);
      }
    }
  }
});

test("decoders refuse what they cannot read", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")));
  assert.throws(() => decodeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /no frame/);
  assert.throws(() => decodeGif(Buffer.from("GIF89a")));
  const truncated = Buffer.from(IMAGE_FIXTURES.find((fixture) => fixture.name === "png-rgb")!.file, "base64");
  assert.throws(() => decodePng(truncated.subarray(0, truncated.length - 30)));
});

test("encoders round-trip: PNG exactly (RGB when opaque), JPEG by quality", () => {
  const translucent = pattern(37, 23, (x) => (x * 7) % 256), opaque = pattern(37, 23);
  const rgba = encodePng(translucent), rgb = encodePng(opaque);
  assert.equal(rgba[25], 6);
  assert.equal(rgb[25], 2);
  assert.deepEqual(decodePng(rgba).data, translucent.data);
  assert.deepEqual(decodePng(rgb).data, opaque.data);
  const smooth = pattern(64, 40);
  const sizes = [100, 80, 20].map((quality) => {
    const encoded = encodeJpeg(smooth, quality);
    const decoded = decodeJpeg(encoded).raster;
    assert.deepEqual([decoded.width, decoded.height], [64, 40]);
    assert.ok(psnr(decoded.data, smooth.data) >= (quality === 100 ? 45 : quality === 80 ? 36 : 28), `q${quality}`);
    return encoded.length;
  });
  assert.ok(sizes[0]! > sizes[1]! && sizes[1]! > sizes[2]!);
  // Annex K tables at quality 50 are written unscaled (DQT in zigzag order).
  const q50 = encodeJpeg(smooth, 50);
  const dqt = q50.indexOf(Buffer.from([0xff, 0xdb]));
  assert.deepEqual([...q50.subarray(dqt + 5, dqt + 9)], [16, 11, 12, 14]);
  const symbols = new Set([0x00, 0xf0]);
  for (let run = 0; run < 16; run += 1) for (let size = 1; size <= 10; size += 1) symbols.add((run << 4) | size);
  for (const values of [AC_LUMA_VALUES, AC_CHROMA_VALUES]) {
    assert.equal(values.length, 162);
    assert.deepEqual(new Set(values), symbols);
  }
});

test("resampling keeps colour and alpha, and EXIF orientation turns the raster", () => {
  const flat = pattern(300, 200, () => 128);
  for (let at = 0; at < flat.data.length; at += 4) flat.data.set([200, 40, 90, 128], at);
  const half = fitWithin(flat, 150);
  assert.deepEqual([half.width, half.height], [150, 100]);
  for (let at = 0; at < half.data.length; at += 4) assert.deepEqual([...half.data.subarray(at, at + 4)], [200, 40, 90, 128]);
  assert.equal(fitWithin(flat, 300), flat);
  assert.deepEqual([fitWithin(pattern(2400, 7), 2000).width, fitWithin(pattern(2400, 7), 2000).height], [2000, 6]);
  const tall = pattern(3, 2);
  const turned = orient(tall, 6);
  assert.deepEqual([turned.width, turned.height], [2, 3]);
  assert.deepEqual([...turned.data.subarray(4, 8)], [...tall.data.subarray(0, 4)]);
});

test("the budget is ZCode's: raw, base64 and 25k-token caps", () => {
  assert.equal(fitsImageBudget(150_000), true);
  assert.equal(fitsImageBudget(150_001), false);
  const small = encodePng(pattern(30, 20));
  const original = prepareImageForModel(small, "image/png");
  assert.equal(original.strategy, "original");
  assert.equal(original.data, small);
  assert.deepEqual([original.width, original.height, original.resized, original.compressed], [30, 20, false, false]);
  assert.throws(() => prepareImageForModel(new Uint8Array(0), "image/png"), { name: "ImagePrepareError", message: "Image file is empty (0 bytes)" });
  assert.throws(() => prepareImageForModel(Buffer.from("not an image"), "image/png"), { message: "Unable to decode image data" });
  const webp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 "), Buffer.alloc(100)]);
  assert.deepEqual([prepareImageForModel(webp, "image/png").mediaType, prepareImageForModel(webp, "image/png").strategy], ["image/webp", "original"]);
  assert.throws(() => prepareImageForModel(Buffer.concat([webp, Buffer.alloc(200_000)]), "image/webp"), (error: unknown) =>
    error instanceof ImagePrepareError && error.code === "unsupported" && error.message === "WebP image exceeds the model image budget and the current image adapter cannot transcode WebP");
});

test("oversized images take ZCode's ladder: JPEG quality, resize, scale steps", () => {
  // A PNG within 2000px that is over budget: one lossless try, then JPEG at the same size.
  const noisy = prepareImageForModel(encodePng(pattern(400, 400, () => 255, true)), "image/png");
  assert.deepEqual([noisy.mediaType, noisy.strategy, noisy.resized, noisy.compressed, noisy.width], ["image/jpeg", "jpeg-quality", false, true, 400]);
  assert.ok(fitsImageBudget(noisy.data.byteLength));
  // Wider than 2000px: bounded first; a JPEG source keeps its format at jimp's default quality.
  const flat = createRaster(2400, 1200);
  for (let at = 0; at < flat.data.length; at += 4) flat.data.set([30, 120, 200, 255], at);
  const wideJpeg = prepareImageForModel(encodeJpeg(flat, 95), "image/jpeg");
  assert.deepEqual([wideJpeg.mediaType, wideJpeg.strategy, wideJpeg.width, wideJpeg.height, wideJpeg.resized], ["image/jpeg", "resized", 2000, 1000, true]);
  const widePng = prepareImageForModel(encodePng(pattern(2400, 60)), "image/png");
  assert.deepEqual([widePng.mediaType, widePng.strategy, widePng.width, widePng.height], ["image/jpeg", "jpeg-quality", 2000, 50]);
  // Noise at 1200px only fits after the progressive 0.75/0.5/0.25 steps.
  const big = prepareImageForModel(encodePng(pattern(1200, 1200, () => 255, true)), "image/png");
  assert.equal(big.mediaType, "image/jpeg");
  assert.ok(big.width! < 1200 && fitsImageBudget(big.data.byteLength), `${big.strategy} ${big.width}`);
});

test("an oversized GIF stays a GIF through the preserve-format step", () => {
  // A smooth 300x300 GIF re-encodes far below the budget, but this file is
  // padded past it (bytes after the trailer are not part of the frame), so the
  // original cannot pass through unchanged and the ladder has to run.
  const smooth = pattern(300, 300);
  const padded = Buffer.concat([encodeGif(smooth), Buffer.alloc(200_000)]);
  assert.equal(fitsImageBudget(padded.byteLength), false);
  const prepared = prepareImageForModel(padded, "image/gif");
  assert.deepEqual([prepared.mediaType, prepared.strategy, prepared.width, prepared.height], ["image/gif", "preserve-format", 300, 300]);
  assert.ok(fitsImageBudget(prepared.data.byteLength));
  // ZCode's `encodeCandidate(image, "image/gif", "preserve-format")`: a real GIF.
  const reread = decodeGif(prepared.data);
  assert.deepEqual([reread.width, reread.height], [300, 300]);
  // 256-colour quantisation of a smooth gradient; the JPEG fallback at the same
  // size scores worse, which is the point of keeping the format.
  assert.ok(psnr(reread.data, smooth.data) > 25, `${psnr(reread.data, smooth.data).toFixed(1)} dB`);
});

test("a transparent area keeps its stored colour instead of being painted white", () => {
  // Dark noise with alpha 0 everywhere: the PNG is over the budget, so the
  // ladder re-encodes it as JPEG, which has no alpha channel. jimp's encoder
  // ignores alpha, so the colour stored under the transparent pixels survives.
  // Dark colours make the two behaviours far apart: keeping them scores ~11,
  // painting white would score ~227.
  const hidden = pattern(400, 400, () => 0, true, 40);
  const prepared = prepareImageForModel(encodePng(hidden), "image/png");
  assert.equal(prepared.mediaType, "image/jpeg");
  const decoded = decodeJpeg(prepared.data).raster;
  // Only RGB is comparable: JPEG has no alpha, so the decoded alpha is 255
  // where the source stored 0.
  let error = 0;
  for (let at = 0; at < decoded.data.length; at += 4) {
    for (let channel = 0; channel < 3; channel += 1) error += Math.abs(decoded.data[at + channel]! - hidden.data[at + channel]!);
  }
  const mean = error / (decoded.width * decoded.height * 3);
  assert.ok(mean < 60, `mean channel error ${mean.toFixed(1)}`);
});

test("prepareImage runs on a worker thread and honours abort", async () => {
  const small = encodePng(pattern(30, 20));
  const prepared = await prepareImage(small, "image/png");
  assert.deepEqual([prepared.strategy, prepared.width, Buffer.from(prepared.data).equals(small)], ["original", 30, true]);
  await assert.rejects(prepareImage(Buffer.from("junk"), "image/png"), { name: "ImagePrepareError", message: "Unable to decode image data" });
  await assert.rejects(prepareImage(small, "image/png", AbortSignal.abort()), { message: "Image resize was cancelled" });
  const controller = new AbortController();
  const pending = prepareImage(encodePng(pattern(1500, 1500, () => 255, true)), "image/png", controller.signal);
  controller.abort();
  await assert.rejects(pending, { message: "Image resize was cancelled" });
});
