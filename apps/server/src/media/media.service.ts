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
  Permission,
  VIDEO_MIMES,
  type MediaDto,
  type MediaKind,
  type MediaUploadFields,
} from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import { ENV, type Env } from '../config/env.js';
import type { Media } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { SpacesService } from '../spaces/spaces.service.js';
import { StorageService } from './storage.service.js';

const MB = 1024 * 1024;

export interface UploadedTempFile {
  /** The name the browser sent (latin1-decoded by multer: clients that care send the name as a field). */
  originalname?: string;
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
    private readonly quota: QuotaService,
    private readonly perms: PermissionService,
    private readonly spaces: SpacesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Validates and stores an upload. The client chooses the id, so the same upload can be retried
   * safely: a repeat for an id the user already owns returns the existing record.
   */
  async upload(userId: string, file: UploadedTempFile, fields: MediaUploadFields): Promise<MediaDto> {
    try {
      // Files belong to the space of the page that uses them: the person's own unless another one is named, or the
      // notebook they are writing in says (a notebook shared with them lives in its owner's space).
      let spaceId: string;
      if (fields.notebookId) {
        const access = await this.perms.requireNotebook(userId, fields.notebookId, Permission.EDIT_PAGES);
        spaceId = access.notebook.spaceId;
      } else {
        spaceId = fields.spaceId ?? (await this.spaces.personalSpaceId(userId));
        await this.perms.requireSpace(userId, spaceId, Permission.EDIT_PAGES);
      }
      return toMediaDto(await this.store(userId, spaceId, file, fields));
    } finally {
      await this.storage.discard(file.path);
    }
  }

  /**
   * Validates and stores a file for a space the caller has already been allowed to write to: type by the bytes, size
   * limits, EXIF stripped, quota charged. `inTransaction` runs in the same database transaction as the Media row, so
   * whatever the file belongs to (a chat attachment) exists or not together with it. Does not delete `file`: the caller does.
   */
  async store(
    userId: string,
    spaceId: string,
    file: UploadedTempFile,
    fields: Pick<MediaUploadFields, 'id' | 'width' | 'height' | 'durationSec'>,
    inTransaction?: (tx: Tx, media: Media) => Promise<void>,
  ): Promise<Media> {
    let processed: string | undefined;
    try {
      const existing = await this.prisma.media.findUnique({ where: { id: fields.id } });
      if (existing) {
        if (existing.spaceId !== spaceId) throw new ConflictException('id_taken');
        return existing;
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

      // An admin may lower the largest single file for one account; the instance setting is the ceiling.
      const maxFileBytes = await this.quota.maxFileBytesForSpace(spaceId);
      let limit = (kind === 'image' ? this.env.MAX_IMAGE_MB : this.env.MAX_VIDEO_MB) * MB;
      if (maxFileBytes > 0) limit = Math.min(limit, maxFileBytes);
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

      // Fail fast (before moving a large file), then let the charge inside the transaction be the real gate.
      await this.quota.assertCanStoreInSpace(spaceId, size);

      await this.storage.put(userId, fields.id, sourcePath);
      processed = undefined; // moved
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          // Atomic: two uploads that together exceed the quota cannot both pass.
          await this.quota.chargeSpace(tx, spaceId, size);
          const created = await tx.media.create({
            data: {
              id: fields.id,
              spaceId,
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
          await inTransaction?.(tx, created);
          return created;
        });
        return row;
      } catch (e) {
        // Nothing was recorded (the transaction rolled back); drop the file.
        await this.storage.remove(userId, fields.id).catch(() => undefined);
        throw e;
      }
    } finally {
      await this.storage.discard(processed);
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

  /** The row, or 404 when it does not exist or the person cannot see the space it belongs to. */
  async accessible(userId: string, id: string): Promise<Media> {
    const row = await this.prisma.media.findUnique({ where: { id }, include: { attachment: { select: { channelId: true } } } });
    if (!row) throw new NotFoundException();
    // A chat attachment is as visible as its channel (and not more: being in the team is not enough, and leaving it ends access).
    if (row.attachment) {
      // A file in a direct message is for the two people of the conversation, whatever teams they are in.
      const conversation = await this.prisma.directConversation.findUnique({
        where: { channelId: row.attachment.channelId },
        select: { userA: true, userB: true },
      });
      if (conversation) {
        if (conversation.userA !== userId && conversation.userB !== userId) throw new NotFoundException();
        return row;
      }
      if (!(await this.perms.channelAccess(userId, row.attachment.channelId))) throw new NotFoundException();
      return row;
    }
    if (await this.perms.spaceAccess(userId, row.spaceId)) return row;
    // What the person uploaded themselves (into somebody else's notebook, before the page that uses it was saved).
    if (row.userId === userId && (await this.perms.sharesOf(userId)).some((s) => s.notebook.spaceId === row.spaceId && s.access === 'edit')) return row;
    // A notebook shared with the person: the files its pages use, and nothing else in that space.
    const used = await this.prisma.pageMedia.findFirst({
      where: { mediaId: id, page: { deletedAt: null, notebook: { deletedAt: null, shares: { some: { userId } } } } },
      select: { mediaId: true },
    });
    if (!used) throw new NotFoundException();
    return row;
  }

  filePath(row: Media): string {
    return this.storage.mediaPath(row.userId, row.id);
  }
}
