// Central image-preparation for outbound WhatsApp product images.
//
// Meta's Cloud API rejects any image (sent by `link` OR uploaded to /media)
// larger than 5 MB (error 131053: "Image file has size ... but must be
// atmost 5242880 bytes and non-empty"). Product images pulled from the
// catalog/store are frequently much larger (10-20 MB phone-camera/DSLR
// photos), so every AI product-image send must pass through here first.
//
// prepareProductImage(url) -> { buffer, mime, sourceSize, finalSize, compressed }
//   - downloads the source image, then delegates to prepareImageBuffer()
//
// prepareImageBuffer(buffer) -> same shape, for callers that already have
//   the bytes in memory (e.g. routes/mediaLibrary.js's Meta sync, which
//   reads the original from Postgres storage and only needs to shrink the
//   Meta-bound copy — the stored original is never touched/overwritten).
//   - validates it's a real, non-empty, decodable image
//   - if already comfortably under the limit, returns it untouched
//     (no recompression) so we don't degrade small images for nothing
//   - if too large, resizes/recompresses (progressively) until it fits
//     under TARGET_BYTES, preserving orientation and, where practical,
//     transparency
//
// The caller is expected to upload the returned buffer via
// integrations/metaSend.js's uploadMedia() and send using the resulting
// media_id (NOT the original link/local file) — see routes/webhook.js and
// routes/mediaLibrary.js.

const sharp = require('sharp');

// Meta's hard ceiling.
const META_MAX_BYTES = 5 * 1024 * 1024; // 5,242,880
// Our safety-margin target (per task spec: comfortably below 5MB, ~4.5MB).
const TARGET_BYTES = Math.floor(4.5 * 1024 * 1024);

const FORMAT_TO_MIME = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Download the source image over HTTP(S). Throws with a clear, specific
 * message on any failure (network error, non-2xx, empty body).
 */
async function downloadImage(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== 'string') {
    throw new Error('image preparation: no source image URL provided');
  }
  let res;
  try {
    res = await fetch(sourceUrl);
  } catch (err) {
    throw new Error(`image preparation: download failed (network error): ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`image preparation: download failed (HTTP ${res.status})`);
  }
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  if (!buffer || buffer.length === 0) {
    throw new Error('image preparation: downloaded image is empty (zero-byte)');
  }
  return buffer;
}

/**
 * Progressively compress a photographic (no meaningful alpha) image to
 * JPEG, stepping quality down and, if quality alone isn't enough, scaling
 * width down, until the result fits under targetBytes.
 */
async function compressToJpeg(srcBuffer, width, targetBytes) {
  let outBuffer = null;
  let currentWidth = width;
  const qualitySteps = [82, 70, 60, 50, 40, 30, 22];

  for (let pass = 0; pass < 4 && (!outBuffer || outBuffer.length > targetBytes); pass++) {
    for (const quality of qualitySteps) {
      outBuffer = await sharp(srcBuffer, { failOn: 'none' })
        .rotate() // bake in EXIF orientation, then strip it
        .resize({ width: currentWidth, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (outBuffer.length <= targetBytes) return outBuffer;
    }
    // Still too big even at lowest quality — shrink dimensions and retry.
    currentWidth = Math.round(currentWidth * 0.75);
  }
  return outBuffer;
}

/**
 * Progressively compress an image that has meaningful transparency,
 * keeping it as PNG for as long as practical (scaling down + max
 * compression) before falling back to a flattened JPEG as a last resort.
 */
async function compressPreservingAlpha(srcBuffer, width, targetBytes) {
  let outBuffer = null;
  let currentWidth = width;

  for (let pass = 0; pass < 6; pass++) {
    outBuffer = await sharp(srcBuffer, { failOn: 'none' })
      .rotate()
      .resize({ width: currentWidth, withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: pass >= 2 })
      .toBuffer();
    if (outBuffer.length <= targetBytes) return { buffer: outBuffer, mime: 'image/png' };
    currentWidth = Math.round(currentWidth * 0.8);
  }

  // Last resort: flatten transparency onto white and use JPEG so we can
  // reliably hit the size target even for very large transparent PNGs.
  const jpegBuffer = await compressToJpeg(
    await sharp(srcBuffer, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).toBuffer(),
    width,
    targetBytes
  );
  return { buffer: jpegBuffer, mime: 'image/jpeg' };
}

/**
 * Prepare an already-in-memory image buffer for sending to Meta. Same
 * validation/compression rules as prepareProductImage(), minus the
 * download step — used by callers that already have the bytes (e.g. the
 * Media Library, which stores originals in Postgres and only needs to
 * shrink the Meta-bound copy at sync time, never the stored original).
 * Always returns a buffer safely under Meta's 5MB limit (target ~4.5MB),
 * or throws a descriptive error (never returns a corrupt/empty/oversized
 * result).
 */
async function prepareImageBuffer(srcBuffer, { targetBytes = TARGET_BYTES } = {}) {
  if (!srcBuffer || srcBuffer.length === 0) {
    throw new Error('image preparation: source buffer is empty (zero-byte)');
  }
  const sourceSize = srcBuffer.length;

  // Validate it's actually a decodable image before doing anything else.
  let meta;
  try {
    meta = await sharp(srcBuffer, { failOn: 'none' }).metadata();
  } catch (err) {
    throw new Error(`image preparation: invalid/undecodable image: ${err.message}`);
  }
  if (!meta || !meta.format || !meta.width || !meta.height) {
    throw new Error('image preparation: unrecognized or unsupported image format');
  }

  // Already comfortably under the limit — preserve as-is, no recompression.
  if (sourceSize <= targetBytes) {
    const mime = FORMAT_TO_MIME[meta.format] || 'application/octet-stream';
    return { buffer: srcBuffer, mime, sourceSize, finalSize: sourceSize, compressed: false };
  }

  const hasAlpha = !!meta.hasAlpha;
  let result;
  if (hasAlpha) {
    result = await compressPreservingAlpha(srcBuffer, meta.width, targetBytes);
  } else {
    const buffer = await compressToJpeg(srcBuffer, meta.width, targetBytes);
    result = { buffer, mime: 'image/jpeg' };
  }

  if (!result || !result.buffer || result.buffer.length === 0) {
    throw new Error('image preparation: compression produced an empty/corrupt result');
  }
  if (result.buffer.length > META_MAX_BYTES) {
    throw new Error(
      `image preparation: unable to compress image below Meta's 5MB limit ` +
      `(source=${sourceSize} bytes, best-effort=${result.buffer.length} bytes)`
    );
  }

  return {
    buffer: result.buffer,
    mime: result.mime,
    sourceSize,
    finalSize: result.buffer.length,
    compressed: true,
  };
}

/**
 * Prepare a product image for sending to Meta. Always returns a buffer
 * safely under Meta's 5MB limit (target ~4.5MB), or throws a descriptive
 * error (never returns a corrupt/empty/oversized result).
 */
async function prepareProductImage(sourceUrl, { targetBytes = TARGET_BYTES } = {}) {
  const srcBuffer = await downloadImage(sourceUrl);
  return prepareImageBuffer(srcBuffer, { targetBytes });
}

module.exports = { prepareProductImage, prepareImageBuffer, META_MAX_BYTES, TARGET_BYTES };






