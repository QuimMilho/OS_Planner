import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  hasPermission,
  Permission,
  type AttachmentDto,
  type AttachmentFields,
} from '@os-planner/shared';
import { MediaService, type UploadedTempFile } from '../media/media.service.js';
import { StorageService } from '../media/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelsService } from './channels.service.js';
import { DirectService } from './direct.service.js';

/** A file name safe to show and to put in a download: no path, no control characters, not too long. */
export function cleanFileName(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const base = (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()!
    .trim();
  return (base || 'file').slice(0, 200);
}

/**
 * Files sent with messages. The upload comes first (the file is checked, charged to the space the channel belongs to and
 * stored together with its Attachment row); sending the message then attaches it. One that is never attached is removed
 * by the nightly job and the space gets its bytes back.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly channels: ChannelsService,
    private readonly storage: StorageService,
    private readonly direct: DirectService,
  ) {}

  async upload(
    userId: string,
    channelId: string,
    file: UploadedTempFile,
    fields: AttachmentFields,
  ): Promise<AttachmentDto> {
    try {
      const access = await this.channels.textChannel(userId, channelId);
      if (!hasPermission(access.perms, Permission.ATTACH_FILES))
        throw new ForbiddenException('forbidden');
      if (access.channel.archivedAt) throw new ConflictException('channel_archived');
      if (access.dm) await this.direct.assertAllowed(userId, access.dm.peerId);
      // A channel's files count against its team or project; a conversation's against the person who sends them.
      const spaceId = await this.channels.billingSpace(access, userId);
      if (!spaceId) throw new ForbiddenException('forbidden');

      const media = await this.media.store(
        userId,
        spaceId,
        file,
        fields,
        async (tx, created) => {
          await tx.attachment.create({
            data: {
              id: created.id,
              channelId,
              mediaId: created.id,
              uploadedBy: userId,
              name: cleanFileName(fields.name),
            },
          });
        },
      );
      // A retry of an upload that already worked finds its attachment; one for somebody else's id is refused.
      const row = await this.prisma.attachment.findUnique({
        where: { id: media.id },
        include: { media: true },
      });
      if (!row || row.channelId !== channelId || row.uploadedBy !== userId)
        throw new ConflictException('id_taken');
      return {
        id: row.id,
        mediaId: row.mediaId,
        name: row.name,
        mime: row.media.mime,
        size: row.media.size,
        width: row.media.width,
        height: row.media.height,
        kind: row.media.kind === 'video' ? 'video' : 'image',
      };
    } finally {
      await this.storage.discard(file.path);
    }
  }
}
