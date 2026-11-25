import { copyFile, mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where files live on disk: `<DATA_DIR>/uploads/<userId>/<mediaId>`, plus a tmp area for
 * in-flight uploads and the downloads folder served at /downloads. Paths are only ever built
 * from validated UUIDs, so user input can never escape the data directory.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  readonly root: string;
  readonly uploads: string;
  readonly tmp: string;
  readonly downloads: string;

  constructor(@Inject(ENV) env: Env) {
    this.root = resolve(env.DATA_DIR);
    this.uploads = join(this.root, 'uploads');
    this.tmp = join(this.root, 'tmp');
    this.downloads = join(this.root, 'downloads');
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([this.uploads, this.tmp, this.downloads].map((d) => mkdir(d, { recursive: true })));
  }

  mediaPath(userId: string, mediaId: string): string {
    if (!UUID.test(userId) || !UUID.test(mediaId)) throw new Error('invalid storage key');
    return join(this.uploads, userId, mediaId);
  }

  /** Moves a finished upload into place (falls back to copy across devices). */
  async put(userId: string, mediaId: string, sourcePath: string): Promise<void> {
    const dest = this.mediaPath(userId, mediaId);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(sourcePath, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await copyFile(sourcePath, dest);
      await unlink(sourcePath);
    }
  }

  async remove(userId: string, mediaId: string): Promise<void> {
    await rm(this.mediaPath(userId, mediaId), { force: true });
  }

  async sizeOf(path: string): Promise<number> {
    return (await stat(path)).size;
  }

  /** Best-effort cleanup of temp files; never throws. */
  async discard(...paths: (string | undefined)[]): Promise<void> {
    await Promise.all(paths.filter(Boolean).map((p) => rm(p!, { force: true }).catch(() => undefined)));
  }
}
