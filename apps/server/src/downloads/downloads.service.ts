import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  releaseManifestSchema,
  type DownloadsDto,
  type PublishReleaseInput,
  type ReleaseFile,
  type ReleaseManifest,
} from '@notes/shared';
import { StorageService } from '../media/storage.service.js';

/** Installers are large; this is a safety cap, not a target. */
const MAX_FILE_BYTES = 1.5 * 1024 * 1024 * 1024;
const MANIFEST = 'manifest.json';

/** Files a release may contain: installers plus electron-updater's metadata. */
const ALLOWED_EXTENSIONS = new Set(['.exe', '.appimage', '.deb', '.rpm', '.yml', '.blockmap', '.zip']);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,150}$/;

export function assertReleaseFileName(name: string): void {
  if (!SAFE_NAME.test(name) || name.includes('..') || !ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())) {
    throw new BadRequestException('invalid_file_name');
  }
  if (name === MANIFEST) throw new BadRequestException('invalid_file_name');
}

@Injectable()
export class DownloadsService {
  private readonly log = new Logger(DownloadsService.name);

  constructor(private readonly storage: StorageService) {}

  async current(): Promise<DownloadsDto> {
    try {
      const raw = JSON.parse(await readFile(join(this.storage.downloads, MANIFEST), 'utf8'));
      const parsed = releaseManifestSchema.safeParse(raw);
      return { release: parsed.success ? parsed.data : null };
    } catch {
      return { release: null };
    }
  }

  /** Streams an upload to disk (never into memory) and puts it in place atomically. */
  async receiveFile(name: string, body: Readable): Promise<{ name: string; size: number }> {
    assertReleaseFileName(name);
    const tmp = join(this.storage.tmp, `${randomUUID()}.part`);
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) cb(new PayloadTooLargeException('file_too_large'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(tmp));
      if (size === 0) throw new BadRequestException('empty_file');
      await rename(tmp, join(this.storage.downloads, name));
      return { name, size };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * Records which of the uploaded files make up a release. Size and SHA-256 are computed here
   * from the files on disk, so the download page can show checksums the publisher cannot get wrong.
   */
  async publish(input: PublishReleaseInput): Promise<ReleaseManifest> {
    const files: ReleaseFile[] = [];
    for (const f of input.files) {
      assertReleaseFileName(f.name);
      const path = join(this.storage.downloads, f.name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new UnprocessableEntityException({ message: 'file_not_uploaded', name: f.name });
      files.push({ ...f, size: info.size, sha256: await sha256File(path) });
    }
    const manifest: ReleaseManifest = {
      version: input.version,
      releasedAt: new Date().toISOString(),
      notes: input.notes,
      files,
    };
    const tmp = join(this.storage.tmp, `${randomUUID()}.json`);
    await writeFile(tmp, JSON.stringify(manifest, null, 2));
    await rename(tmp, join(this.storage.downloads, MANIFEST));
    this.log.log(`Published release ${manifest.version} (${files.length} files)`);
    return manifest;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
