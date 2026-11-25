import { z } from 'zod';

export const releaseOsSchema = z.enum(['windows', 'linux']);
export type ReleaseOs = z.infer<typeof releaseOsSchema>;

export const releaseFormatSchema = z.enum(['nsis', 'portable', 'appimage', 'deb', 'rpm']);
export type ReleaseFormat = z.infer<typeof releaseFormatSchema>;

export const releaseFileSchema = z.object({
  /** File name under /downloads/. */
  name: z.string().regex(/^[\w][\w.\- ]{0,150}$/),
  os: releaseOsSchema,
  arch: z.enum(['x64', 'arm64']),
  format: releaseFormatSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReleaseFile = z.infer<typeof releaseFileSchema>;

/**
 * What a publisher sends after uploading the files. Size and checksum are deliberately not part
 * of it: the server measures the files it actually holds.
 */
export const publishReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/),
  notes: z.string().max(5000).default(''),
  files: z.array(releaseFileSchema.pick({ name: true, os: true, arch: true, format: true })).min(1).max(30),
});
export type PublishReleaseInput = z.infer<typeof publishReleaseSchema>;

export interface DownloadsDto {
  /** The latest published release, or null if none has been published yet. */
  release: ReleaseManifest | null;
}

export const releaseManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/),
  releasedAt: z.string(),
  notes: z.string().max(5000).default(''),
  files: z.array(releaseFileSchema),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
