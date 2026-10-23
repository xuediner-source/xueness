/**
 * Read's model image budget: ZCode v3.15.1 (aac4755, Apache-2.0)
 * `adapters/src/image/jimp-compression.ts` (`prepareJimpImageForModel`),
 * `image-budget.ts`, `webp-passthrough.ts`, `jimp-media.ts` and
 * `contracts/src/model/image-media.ts`, on the pure-TS codecs of this folder.
 *
 * Differences (no jimp): the GIF steps re-encode through this folder's own
 * GIF89a encoder instead of jimp's, and JPEG candidates keep the colour stored
 * under transparent pixels instead of compositing them onto a background.
 */
import { decodeGif, isGif } from "./gif.ts";
import { encodeGif } from "./gif-encode.ts";
import { decodeJpeg } from "./jpeg-decode.ts";
import { encodeJpeg } from "./jpeg-encode.ts";
import { decodePng, encodePng, isPng } from "./png.ts";
import { dropAlpha, fitWithin, isOpaque, orient, type Raster } from "./raster.ts";

export const READ_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024;
export const READ_IMAGE_TARGET_BYTES = Math.floor((READ_IMAGE_MAX_BASE64_BYTES * 3) / 4);
export const READ_IMAGE_MAX_DIMENSION = 2000;
export const READ_IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO = 0.125;
const READ_IMAGE_MAX_TOKENS = 25_000;
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;
const PROGRESSIVE_SCALE_FACTORS = [0.75, 0.5, 0.25] as const;
const AGGRESSIVE_JPEG_MAX_EDGES = [1000, 800, 600, 400, 300, 200] as const;
/** jimp's default JPEG quality, used by the `resized` candidate. */
const JIMP_DEFAULT_JPEG_QUALITY = 100;

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ImageStrategy = "original" | "png-optimized" | "jpeg-quality" | "resized" | "preserve-format" | "jpeg-fallback";
export type ImagePrepareErrorCode = "empty" | "processing_failed" | "unsupported" | "too_large";

export interface PreparedImage {
  data: Uint8Array;
  mediaType: ImageMediaType;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  resized: boolean;
  compressed: boolean;
  strategy: ImageStrategy;
  originalSizeBytes: number;
  transformedSizeBytes: number;
}

export class ImagePrepareError extends Error {
  readonly code: ImagePrepareErrorCode;
  constructor(code: ImagePrepareErrorCode, message: string) {
    super(message);
    this.name = "ImagePrepareError";
    this.code = code;
  }
}

interface Candidate { data: Uint8Array; mediaType: ImageMediaType; strategy: ImageStrategy; width: number; height: number }

export function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (isPng(data)) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 3 && isGif(data)) return "image/gif";
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "image/webp";
  return undefined;
}

export function normalizeImageMediaType(value: string): ImageMediaType {
  const lower = value.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  return lower === "image/jpeg" || lower === "image/png" || lower === "image/gif" || lower === "image/webp" ? lower : "image/png";
}

/** ZCode `fitsImageBudget` with Read's budget (raw, base64 and token caps). */
export function fitsImageBudget(byteLength: number): boolean {
  const base64Bytes = Math.ceil(byteLength / 3) * 4;
  return byteLength <= READ_IMAGE_TARGET_BYTES && base64Bytes <= READ_IMAGE_MAX_BASE64_BYTES
    && Math.ceil(base64Bytes * READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO) <= READ_IMAGE_MAX_TOKENS;
}

function decode(data: Uint8Array): Raster {
  if (isPng(data)) return decodePng(data);
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const { raster, orientation } = decodeJpeg(data);
    return orient(raster, orientation);
  }
  if (isGif(data)) return decodeGif(data);
  throw new Error("unsupported image format");
}

const pngCandidate = (raster: Raster, strategy: ImageStrategy): Candidate =>
  ({ data: encodePng(raster), mediaType: "image/png", strategy, width: raster.width, height: raster.height });
const jpegCandidate = (raster: Raster, quality: number, strategy: ImageStrategy): Candidate =>
  ({ data: encodeJpeg(isOpaque(raster) ? raster : dropAlpha(raster), quality), mediaType: "image/jpeg", strategy, width: raster.width, height: raster.height });
const gifCandidate = (raster: Raster): Candidate =>
  ({ data: encodeGif(raster), mediaType: "image/gif", strategy: "preserve-format", width: raster.width, height: raster.height });
const fit = (candidate: Candidate | undefined): Candidate | undefined => candidate && fitsImageBudget(candidate.data.byteLength) ? candidate : undefined;
const longest = (raster: Raster): number => Math.max(raster.width, raster.height);

function jpegLadder(raster: Raster): Candidate | undefined {
  for (const quality of JPEG_QUALITY_STEPS) {
    const candidate = fit(jpegCandidate(raster, quality, "jpeg-quality"));
    if (candidate) return candidate;
  }
  return undefined;
}

function formatPreserving(raster: Raster, mediaType: ImageMediaType): Candidate | undefined {
  if (mediaType === "image/png") return fit(pngCandidate(raster, "png-optimized"));
  if (mediaType === "image/jpeg") return jpegLadder(raster);
  // ZCode re-encodes a GIF as a GIF (`encodeCandidate(image, "image/gif", "preserve-format")`).
  if (mediaType === "image/gif") return fit(gifCandidate(raster));
  return undefined;
}

function firstFitting(image: Raster, source: ImageMediaType): Candidate | undefined {
  const within = image.width <= READ_IMAGE_MAX_DIMENSION && image.height <= READ_IMAGE_MAX_DIMENSION;
  // ZCode: PNG keeps one lossless attempt at the original size, then goes one-way to JPEG.
  const preserve = source !== "image/png";
  if (within) {
    const candidate = formatPreserving(image, source);
    if (candidate) return candidate;
  }
  const bounded = fitWithin(image, READ_IMAGE_MAX_DIMENSION);
  if (preserve && (bounded.width !== image.width || bounded.height !== image.height) && source === "image/jpeg") {
    const candidate = fit(jpegCandidate(bounded, JIMP_DEFAULT_JPEG_QUALITY, "resized"));
    if (candidate) return candidate;
  }
  if (!within && preserve) {
    const candidate = formatPreserving(bounded, source);
    if (candidate) return candidate;
  }
  const boundedJpeg = jpegLadder(bounded);
  if (boundedJpeg) return boundedJpeg;
  for (const scale of PROGRESSIVE_SCALE_FACTORS) {
    const scaled = fitWithin(bounded, Math.max(1, Math.round(longest(bounded) * scale)));
    if (preserve) {
      const candidate = formatPreserving(scaled, source);
      if (candidate) return candidate;
    }
    const candidate = jpegLadder(scaled);
    if (candidate) return candidate;
  }
  for (const maxEdge of AGGRESSIVE_JPEG_MAX_EDGES) {
    const candidate = fit(jpegCandidate(fitWithin(image, Math.min(maxEdge, READ_IMAGE_MAX_DIMENSION)), 20, "jpeg-fallback"));
    if (candidate) return candidate;
  }
  return undefined;
}

/** Fit `input` (a file claimed to be `mediaType`) into Read's model image budget. */
export function prepareImageForModel(input: Uint8Array, mediaType: string): PreparedImage {
  if (input.byteLength === 0) throw new ImagePrepareError("empty", "Image file is empty (0 bytes)");
  const detected = detectImageMediaType(input) ?? normalizeImageMediaType(mediaType);
  const size = input.byteLength;
  if (detected === "image/webp") {
    if (!fitsImageBudget(size)) throw new ImagePrepareError("unsupported", "WebP image exceeds the model image budget and the current image adapter cannot transcode WebP");
    return { data: input, mediaType: "image/webp", originalSizeBytes: size, resized: false, compressed: false, strategy: "original", transformedSizeBytes: size };
  }
  let image: Raster;
  try {
    image = decode(input);
  } catch {
    throw new ImagePrepareError("processing_failed", "Unable to decode image data");
  }
  const originalWidth = image.width, originalHeight = image.height;
  if (originalWidth <= READ_IMAGE_MAX_DIMENSION && originalHeight <= READ_IMAGE_MAX_DIMENSION && fitsImageBudget(size)) {
    return { data: input, mediaType: detected, originalWidth, originalHeight, width: originalWidth, height: originalHeight, resized: false, compressed: false, strategy: "original", originalSizeBytes: size, transformedSizeBytes: size };
  }
  const candidate = firstFitting(image, detected);
  if (!candidate) throw new ImagePrepareError("too_large", `Unable to compress image (${size} bytes) within the requested model image budget`);
  return {
    data: candidate.data, mediaType: candidate.mediaType, originalWidth, originalHeight, width: candidate.width, height: candidate.height,
    resized: candidate.width !== originalWidth || candidate.height !== originalHeight,
    compressed: candidate.data.byteLength < size || candidate.mediaType !== detected,
    strategy: candidate.strategy, originalSizeBytes: size, transformedSizeBytes: candidate.data.byteLength,
  };
}
