import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

export const png = (width = 8, height = 6, color = '#3b5bdb') =>
  sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

/**
 * A JPEG whose EXIF block carries identifying metadata, with orientation 6 ("rotate 90°").
 * (Orientation must be set through `orientation`: libvips ignores it inside the EXIF map.)
 */
export const jpegWithExif = (width = 20, height = 10) =>
  sharp({ create: { width, height, channels: 3, background: '#cc3300' } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Copyright: 'SECRET-OWNER', ImageDescription: 'taken at home' } },
    })
    .toBuffer();

/** Sniffs as a JPEG and carries EXIF, but the image data is cut off, so re-encoding it fails. */
export const truncatedJpegWithExif = async () => {
  const full = await sharp({
    create: { width: 400, height: 400, channels: 3, background: '#123456', noise: { type: 'gaussian', mean: 128, sigma: 50 } },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: 'SECRET-OWNER' } } })
    .toBuffer();
  return full.subarray(0, Math.floor(full.length * 0.4));
};

/**
 * Smallest thing file-type recognises as MP4: an `ftyp` box followed by filler. The server never
 * decodes video, so a real stream is not needed, and a random body makes Range checks meaningful.
 */
export function fakeMp4(bodyBytes = 4000): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d,
    0x70, 0x34, 0x31,
  ]);
  return Buffer.concat([ftyp, randomBytes(bodyBytes)]);
}

export const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const html = Buffer.from('<!doctype html><script>alert(1)</script>');
export const exe = Buffer.concat([Buffer.from('MZ'), randomBytes(200)]);
/** PNG signature followed by junk. Not recognised as a PNG at all, so it is rejected as unsupported. */
export const brokenPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
