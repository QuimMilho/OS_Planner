import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { IMAGE_MIMES, VIDEO_MIMES } from '@os-planner/shared/lite';
import type { MediaKind, MediaTokenResponse } from '@os-planner/shared';
import { apiUrl } from '../core/api-config';
import { ApiProblem } from '../core/auth-store';
import { uuidv7 } from '../core/ids';
import { Db } from './db';
import { Outbox } from './outbox';

export interface AddedMedia {
  id: string;
  kind: MediaKind;
  width: number | null;
  height: number | null;
  /** For videos: the id of the poster frame (a separate image upload), if one could be captured. */
  posterId: string | null;
}

/** Images up to this size are also cached locally after first view, so they show offline. */
const CACHE_IMAGES_UP_TO = 8 * 1024 * 1024;

/**
 * Pictures and videos. A file is stored in the local database the moment it is added, so it
 * shows instantly and works offline; Sync uploads it later, before the page that uses it is saved.
 */
@Injectable({ providedIn: 'root' })
export class MediaStore {
  private readonly dbs = inject(Db);
  private readonly http = inject(HttpClient);
  private readonly outbox = inject(Outbox);

  private readonly objectUrls = new Map<string, string>();
  private token: { value: string; expiresAt: number } | null = null;

  /** Detects the real type from the file, stores it locally, and (for videos) captures a poster frame. */
  async add(file: File | Blob, notebookId?: string | null): Promise<AddedMedia> {
    const mime = file.type;
    const kind: MediaKind | null = (IMAGE_MIMES as readonly string[]).includes(mime)
      ? 'image'
      : (VIDEO_MIMES as readonly string[]).includes(mime)
        ? 'video'
        : null;
    if (!kind) throw new ApiProblem(415, 'unsupported_media_type');

    const id = uuidv7();
    let width: number | null = null;
    let height: number | null = null;
    let durationSec: number | null = null;
    let posterId: string | null = null;

    if (kind === 'image') {
      ({ width, height } = await imageSize(file));
    } else {
      const probe = await probeVideo(file);
      ({ width, height, durationSec } = probe);
      if (probe.poster) posterId = (await this.storePoster(probe.poster, notebookId)).id;
    }

    await this.dbs.db.media.add({ id, kind, mime, size: file.size, blob: file, uploaded: 0, width, height, durationSec, notebookId: notebookId ?? null });
    this.outbox.changed.next(); // wakes Sync so the upload starts
    return { id, kind, width, height, posterId };
  }

  private async storePoster(blob: Blob, notebookId?: string | null): Promise<{ id: string }> {
    const id = uuidv7();
    await this.dbs.db.media.add({ id, kind: 'image', mime: blob.type, size: blob.size, blob, uploaded: 0, width: null, height: null, durationSec: null, notebookId: notebookId ?? null });
    return { id };
  }

  /**
   * A URL for <img>/<video>. Local blobs win (instant, offline); an image only on the server is
   * downloaded once and cached; videos stream from the server with a scoped token (Range supported).
   */
  async urlFor(id: string, kind: MediaKind): Promise<string | null> {
    const cached = this.objectUrls.get(id);
    if (cached) return cached;

    const row = await this.dbs.db.media.get(id);
    if (row) return this.remember(id, row.blob);

    const token = await this.mediaToken();
    if (!token) return null; // offline and never seen: the node view shows a placeholder
    if (kind === 'image') {
      try {
        const blob = await firstValueFrom(this.http.get(`/api/media/${id}`, { responseType: 'blob' }));
        if (blob.size <= CACHE_IMAGES_UP_TO) {
          await this.dbs.db.media.put({ id, kind, mime: blob.type, size: blob.size, blob, uploaded: 1, width: null, height: null, durationSec: null });
        }
        return this.remember(id, blob);
      } catch {
        /* fall through to the plain URL */
      }
    }
    return apiUrl(`/api/media/${id}?t=${encodeURIComponent(token)}`);
  }

  private remember(id: string, blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.objectUrls.set(id, url);
    return url;
  }

  /** Short-lived token for URLs that cannot carry an Authorization header. Cached until shortly before it expires. */
  async mediaToken(): Promise<string | null> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    try {
      const res = await firstValueFrom(this.http.post<MediaTokenResponse>('/api/auth/media-token', {}));
      this.token = { value: res.token, expiresAt: Date.now() + res.expiresIn * 1000 };
      return res.token;
    } catch {
      return null;
    }
  }

  forgetUrls(): void {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.token = null;
  }
}

async function imageSize(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: null, height: null };
  }
}

function once(target: EventTarget, event: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    target.addEventListener(event, () => (clearTimeout(timer), resolve(true)), { once: true });
  });
}

/** Reads size and length, and grabs a frame to use as the poster. Never throws: an unplayable video just gets no poster. */
async function probeVideo(file: Blob): Promise<{ width: number | null; height: number | null; durationSec: number | null; poster: Blob | null }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    if (!(await once(video, 'loadeddata', 10_000))) return { width: null, height: null, durationSec: null, poster: null };
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    video.currentTime = Math.min(1, (duration ?? 1) / 10);
    await once(video, 'seeked', 5_000);
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 960 / (video.videoWidth || 960));
    canvas.width = Math.round((video.videoWidth || 0) * scale);
    canvas.height = Math.round((video.videoHeight || 0) * scale);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const poster = canvas.width ? await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8)) : null;
    return { width: video.videoWidth || null, height: video.videoHeight || null, durationSec: duration, poster };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
