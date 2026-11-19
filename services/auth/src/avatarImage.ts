import sharp, { type Metadata } from 'sharp';

// ---------------------------------------------------------------------------------------------
// Profile pictures are decoded and encoded again on the server, whatever the browser already did:
// what's stored and served is always a fresh 256 x 256 WebP made from the upload's pixels alone. So it
// carries none of the upload's metadata (EXIF can hold where and when a photo was taken, and on which
// phone), no other frames of an animation, and no bytes hidden after the image, and every picture is
// the same size. sharp (libvips) is native code, kept out of the bundle (package.json "cubr.external")
// and installed in the image by the Dockerfile.
// ---------------------------------------------------------------------------------------------

/** The stored picture's side in pixels, as the web app's editor makes it (AvatarEditor's OUT). */
export const AVATAR_SIZE = 256;

/**
 * The largest upload accepted, per side. A picture is shown at most 256 px wide, and a small file can
 * claim huge dimensions (a 300 KB PNG of one colour can be 20,000 px square): this bounds what one
 * decode takes, 2048 x 2048 x 4 bytes = 16 MB.
 */
export const AVATAR_MAX_SIDE = 2048;

/** WebP quality, as the web app's editor encodes (AvatarEditor). */
const QUALITY = 86;

// Untrusted bytes only ever reach the three decoders cubr accepts: libvips can also read SVG, GIF,
// TIFF, HEIF and more, each one more decoder an attacker could aim at. One picture at a time with no
// cache: the VM is small, and pictures change rarely.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] });
sharp.concurrency(1);
sharp.cache(false);

export class AvatarImageError extends Error {}

const INVALID = 'File is not a valid PNG, JPEG or WebP image';

/**
 * Decodes an uploaded picture (PNG, JPEG or WebP) and encodes it again as a 256 x 256 WebP: turned
 * upright by its EXIF orientation, cropped to the centre square, its first frame only, in sRGB and
 * without any metadata. Throws AvatarImageError when it isn't a decodable picture of at most
 * 2048 x 2048 (the dimensions are read from the header, before any pixel is decoded).
 */
export async function reencodeAvatar(upload: Buffer): Promise<Buffer> {
  const input = { limitInputPixels: AVATAR_MAX_SIDE * AVATAR_MAX_SIDE, pages: 1 };
  let meta: Metadata;
  try {
    // the header alone, without the pixel limit (it decodes nothing), so that too big gets its own answer
    meta = await sharp(upload, { ...input, limitInputPixels: false }).metadata();
  } catch {
    throw new AvatarImageError(INVALID); // sharp also throws synchronously, e.g. for an empty buffer
  }
  if (!meta.width || !meta.height || !['png', 'jpeg', 'webp'].includes(meta.format ?? '')) throw new AvatarImageError(INVALID);
  if (meta.width > AVATAR_MAX_SIDE || meta.height > AVATAR_MAX_SIDE) {
    throw new AvatarImageError(`Picture is too big: at most ${AVATAR_MAX_SIDE} x ${AVATAR_MAX_SIDE} pixels`);
  }
  try {
    return await sharp(upload, input)
      .autoOrient()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
      .webp({ quality: QUALITY })
      .timeout({ seconds: 5 })
      .toBuffer();
  } catch {
    throw new AvatarImageError(INVALID);
  }
}
