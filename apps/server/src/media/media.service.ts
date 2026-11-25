import { join } from 'node:path';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { fileTypeFromFile } from 'file-type';
import sharp from 'sharp';
import {
  IMAGE_MIMES,
  VIDEO_MIMES,
  type MediaDto,
  type MediaKind,
  type MediaUploadFields,
} from '@notes/shared';
import { newId } from '../common/crypto.js';
import { ENV, quotaBytes, type Env } from '../config/env.js';
import type { Media } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from './storage.service.js';

const MB = 1024 * 1024;

export interface UploadedTempFile {
  /** Where multer wrote the upload. Ownership passes to MediaService, which moves or deletes it. */
  path: string;
  size: number;
}

export const toMediaDto = (m: Media): MediaDto => ({
  id: m.id,
  kind: m.kind as MediaKind,
  mime: m.mime,
  size: m.size,
  width: m.width,
  height: m.height,
  durationSec: m.durationSec,
  createdAt: m.createdAt.toISOString(),
});

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Validates and stores an upload. The client chooses the id, so the same upload can be retried
   * safely: a repeat for an id the user already owns returns the existing record.
   */
  async upload(userId: string, file: UploadedTempFile, fields: MediaUploadFields): Promise<MediaDto> {
    let processed: string | undefined;
    try {
      const existing = await this.prisma.media.findUnique({ where: { id: fields.id } });
      if (existing) {
        if (existing.userId !== userId) throw new ConflictException('id_taken');
        return toMediaDto(existing);
      }

      // Trust the bytes, never the client's Content-Type or file name.
      const detected = await fileTypeFromFile(file.path);
      const mime = detected?.mime;
      const kind: MediaKind | null = (IMAGE_MIMES as readonly string[]).includes(mime ?? '')
        ? 'image'
        : (VIDEO_MIMES as readonly string[]).includes(mime ?? '')
          ? 'video'
          : null;
      if (!kind || !mime) throw new UnsupportedMediaTypeException('unsupported_media_type');

      const limit = (kind === 'image' ? this.env.MAX_IMAGE_MB : this.env.MAX_VIDEO_MB) * MB;
      if (file.size > limit) throw new PayloadTooLargeException(`${kind}_too_large`);

      let sourcePath = file.path;
      let size = file.size;
      let width: number | null = fields.width ?? null;
      let height: number | null = fields.height ?? null;

      if (kind === 'image') {
        const probed = await this.probeImage(file.path, mime);
        width = probed.width;
        height = probed.height;
        if (probed.strippedPath) {
          processed = probed.strippedPath;
          sourcePath = probed.strippedPath;
          size = await this.storage.sizeOf(sourcePath);
        }
      }

      // Quota is checked and charged atomically: the conditional UPDATE only matches if there is room.
      const quota = BigInt(quotaBytes(this.env));
      const charged = await this.prisma.user.updateMany({
        where: { id: userId, storageUsedBytes: { lte: quota - BigInt(size) } },
        data: { storageUsedBytes: { increment: size } },
      });
      if (charged.count === 0) throw new PayloadTooLargeException('quota_exceeded');

      try {
        await this.storage.put(userId, fields.id, sourcePath);
        processed = undefined; // moved
        const row = await this.prisma.media.create({
          data: {
            id: fields.id,
            userId,
            kind,
            mime,
            size,
            storageKey: `${userId}/${fields.id}`,
            width,
            height,
            durationSec: kind === 'video' ? (fields.durationSec ?? null) : null,
          },
        });
        return toMediaDto(row);
      } catch (e) {
        // Give the quota back and drop the file if we could not finish.
        await this.prisma.user.update({ where: { id: userId }, data: { storageUsedBytes: { decrement: size } } }).catch(() => undefined);
        await this.storage.remove(userId, fields.id).catch(() => undefined);
        throw e;
      }
    } finally {
      await this.storage.discard(file.path, processed);
    }
  }

  /**
   * Reads dimensions (which also proves the file really decodes) and, for JPEGs that carry
   * EXIF, writes a copy without it. Photos routinely embed GPS coordinates and a note-taking
   * app should not publish those inside exported documents.
   */
  private async probeImage(path: string, mime: string): Promise<{ width: number; height: number; strippedPath?: string }> {
    try {
      const image = sharp(path, { limitInputPixels: 100_000_000, animated: true });
      const meta = await image.metadata();
      if (mime === 'image/jpeg' && meta.exif) {
        const out = join(this.storage.tmp, `${newId()}.jpg`);
        // sharp drops metadata by default; rotate() first bakes the EXIF orientation into the pixels.
        await sharp(path, { limitInputPixels: 100_000_000 }).rotate().jpeg({ quality: 92 }).toFile(out);
        const stripped = await sharp(out).metadata();
        return { width: stripped.width!, height: stripped.height!, strippedPath: out };
      }
      // For animated images `height` is the whole strip; `pageHeight` is one frame.
      return { width: meta.width!, height: meta.pageHeight ?? meta.height! };
    } catch {
      throw new UnprocessableEntityException('invalid_image');
    }
  }

  /** The row, or 404. Callers pass the already-authenticated user id. */
  async owned(userId: string, id: string): Promise<Media> {
    const row = await this.prisma.media.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException();
    return row;
  }

  filePath(row: Media): string {
    return this.storage.mediaPath(row.userId, row.id);
  }
}
