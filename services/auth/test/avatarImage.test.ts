import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_SIDE, AVATAR_SIZE, AvatarImageError, reencodeAvatar } from '../src/avatarImage.js';

const solid = (width: number, height: number, background = '#00a04d') => sharp({ create: { width, height, channels: 3, background } });

/** A width x height picture, red on the left half and blue on the right (raw pixels: no decoder involved). */
function halves(width: number, height: number) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) px.set(i % width < width / 2 ? [255, 0, 0] : [0, 0, 255], i * 3);
  return sharp(px, { raw: { width, height, channels: 3 } });
}

/** One pixel's [r, g, b]. */
async function pixel(img: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(img).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
const isNear = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]) <= 40);

const refusal = async (input: Buffer) => {
  const err = await reencodeAvatar(input).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AvatarImageError);
  return (err as Error).message;
};

describe('reencodeAvatar', () => {
  it('turns every accepted picture into a 256 x 256 WebP, whatever its size and shape', async () => {
    const inputs: [string, Buffer][] = [
      ['png 600x300', await solid(600, 300).png().toBuffer()],
      ['jpeg 100x100', await solid(100, 100).jpeg().toBuffer()],
      ['webp 256x256 (what the web app sends)', await solid(256, 256).webp({ quality: 86 }).toBuffer()],
      ['png 1x1', await solid(1, 1).png().toBuffer()],
      [
        'transparent png',
        await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .png()
          .toBuffer(),
      ],
    ];
    for (const [name, input] of inputs) {
      const out = await reencodeAvatar(input);
      expect(await sharp(out).metadata(), name).toMatchObject({ format: 'webp', width: AVATAR_SIZE, height: AVATAR_SIZE });
    }
    expect(AVATAR_SIZE).toBe(256);
  });

  it('keeps nothing of the upload but its pixels: no EXIF (where a photo was taken), XMP or colour profile', async () => {
    const input = await solid(320, 240)
      .jpeg()
      .withExif({
        IFD0: { ImageDescription: 'secret-home-address', Make: 'PhoneCo' },
        IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '27/1 28/1 3000/100', GPSLongitudeRef: 'E', GPSLongitude: '153/1 1/1 4800/100' },
      })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">secret-xmp-note</rdf:RDF></x:xmpmeta>')
      .withIccProfile('p3')
      .toBuffer();
    const before = await sharp(input).metadata();
    expect(before.exif?.includes('secret-home-address')).toBe(true);
    expect(before.xmp?.includes('secret-xmp-note')).toBe(true);
    expect(before.icc).toBeDefined();

    const out = await reencodeAvatar(input);
    const after = await sharp(out).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.icc).toBeUndefined();
    for (const secret of ['secret-home-address', 'PhoneCo', 'secret-xmp-note']) expect(out.includes(secret), secret).toBe(false);
  });

  it('turns the picture upright by its EXIF orientation before dropping it', async () => {
    // stored sideways (orientation 6: turn 90 degrees clockwise to view): red on the left becomes red on top
    const sideways = await halves(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await reencodeAvatar(sideways);
    expect(isNear(await pixel(out, 128, 40), [255, 0, 0])).toBe(true);
    expect(isNear(await pixel(out, 128, 216), [0, 0, 255])).toBe(true);
    // the same picture without the tag stays as it is: red left, blue right
    const upright = await reencodeAvatar(await halves(200, 100).jpeg().toBuffer());
    expect(isNear(await pixel(upright, 40, 128), [255, 0, 0])).toBe(true);
    expect(isNear(await pixel(upright, 216, 128), [0, 0, 255])).toBe(true);
  });

  it('keeps only the first frame of an animation', async () => {
    const frames = [await solid(64, 64, '#ff0000').png().toBuffer(), await solid(64, 64, '#0000ff').png().toBuffer()];
    const animated = await sharp(frames, { join: { animated: true } })
      .webp()
      .toBuffer();
    expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(2);
    const out = await reencodeAvatar(animated);
    expect((await sharp(out, { pages: -1 }).metadata()).pages ?? 1).toBe(1);
    expect(isNear(await pixel(out, 128, 128), [255, 0, 0])).toBe(true);
  });

  it('refuses a picture over 2048 px a side, from its header (a tiny file can claim a huge picture)', async () => {
    expect(AVATAR_MAX_SIDE).toBe(2048);
    const huge = await solid(3000, 3000).png().toBuffer();
    expect(huge.length).toBeLessThan(300 * 1024); // under the upload limit, as the pixels would be 36 MB
    for (const input of [huge, await solid(2049, 8).png().toBuffer(), await solid(8, 2049).jpeg().toBuffer()]) {
      expect(await refusal(input)).toBe('Picture is too big: at most 2048 x 2048 pixels');
    }
    const largest = await reencodeAvatar(await solid(2048, 2048).png().toBuffer());
    expect((await sharp(largest).metadata()).width).toBe(256);
  });

  it("refuses what doesn't decode as PNG, JPEG or WebP, even behind the right first bytes", async () => {
    const jpeg = await halves(64, 64).jpeg().toBuffer();
    const fakes: [string, Buffer][] = [
      ['png signature, then junk', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])],
      ['jpeg signature, then junk', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)])],
      ['a jpeg cut in half', jpeg.subarray(0, jpeg.length >> 1)],
      ['nothing', Buffer.alloc(0)],
      // formats libvips reads but cubr doesn't take: their decoders are blocked
      ['gif', await solid(16, 16).gif().toBuffer()],
      ['tiff', await solid(16, 16).tiff().toBuffer()],
      ['avif', await solid(16, 16).avif().toBuffer()],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>')],
    ];
    for (const [name, input] of fakes) expect(await refusal(input), name).toBe('File is not a valid PNG, JPEG or WebP image');
  });

  it("installs the same sharp in the image as in the repo (the Dockerfile's pin)", () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile.match(/^ARG SHARP_VERSION=(\S+)$/m)?.[1]).toBe(sharp.versions.sharp);
  });
});
