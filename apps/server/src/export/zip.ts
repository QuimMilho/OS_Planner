import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';

/** Streams a zip archive into `out` without holding the files in memory, honouring backpressure. */
export class ZipWriter {
  private readonly zip: Zip;
  private failed: Error | null = null;

  constructor(private readonly out: Writable) {
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.failed = err;
        out.destroy(err);
        return;
      }
      out.write(chunk);
      if (final) out.end();
    });
  }

  private async drain(): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.out.writableNeedDrain) await once(this.out, 'drain');
  }

  /** Text is compressed. Names containing non-ASCII characters are flagged as UTF-8 by fflate. */
  async addText(name: string, text: string): Promise<void> {
    const file = new ZipDeflate(name, { level: 6 });
    this.zip.add(file);
    file.push(strToU8(text), true);
    await this.drain();
  }

  /** Images and videos are already compressed: store them as they are. */
  async addFile(name: string, path: string): Promise<void> {
    const file = new ZipPassThrough(name);
    this.zip.add(file);
    for await (const chunk of createReadStream(path)) {
      file.push(chunk as Uint8Array, false);
      await this.drain();
    }
    file.push(new Uint8Array(0), true);
    await this.drain();
  }

  end(): void {
    this.zip.end();
  }
}
