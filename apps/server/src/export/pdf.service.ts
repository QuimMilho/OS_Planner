import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import puppeteer, { type Browser, type HTTPRequest } from 'puppeteer-core';
import type { PrintPageSize } from '@os-planner/shared';
import { ENV, type Env } from '../config/env.js';
import { StorageService } from '../media/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { findChrome } from './chrome.js';

/**
 * The print page is loaded from this made-up origin so that *every* request it makes can be
 * intercepted: the document, the print assets and the user's own images are answered locally,
 * and anything else is blocked. Content can therefore never make the server fetch an arbitrary URL.
 */
export const PRINT_ORIGIN = 'https://export.invalid';
export const PRINT_ASSETS_BASE = `${PRINT_ORIGIN}/static/`;
export const printMediaUrl = (id: string): string => `${PRINT_ORIGIN}/media/${id}`;

const MAX_CONCURRENT = 2;
const READY_TIMEOUT_MS = 45_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export interface PdfJob {
  userId: string;
  html: string;
  pageSize: PrintPageSize;
  /** Shown top-left on every page. */
  title: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly log = new Logger(PdfService.name);
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  /** dist/print of @os-planner/shared: print-runtime.js plus KaTeX's CSS and fonts. */
  private readonly assetsDir = join(dirname(createRequire(import.meta.url).resolve('@os-planner/shared')), 'print');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** False when no Chrome/Edge can be found; the web app then falls back to printing locally. */
  get available(): boolean {
    return findChrome(this.env) !== null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
  }

  async render(job: PdfJob): Promise<Buffer> {
    await this.acquire();
    try {
      return await this.renderNow(job);
    } finally {
      this.release();
    }
  }

  // -------------------------------------------------------------- concurrency

  private async acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running++;
      return;
    }
    await new Promise<void>((resolveSlot) => this.waiting.push(resolveSlot));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // the slot passes straight to the next job
    else this.running--;
  }

  // -------------------------------------------------------------- browser

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    const executablePath = findChrome(this.env);
    if (!executablePath) {
      this.log.warn('No Chrome/Chromium found for PDF export. Set CHROME_PATH.');
      throw new ServiceUnavailableException('pdf_unavailable');
    }
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
        '--no-first-run',
        ...(this.env.PDF_NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ],
    });
    browser.on('disconnected', () => {
      if (this.browser === browser) this.browser = null;
    });
    this.browser = browser;
    return browser;
  }

  // -------------------------------------------------------------- rendering

  private async renderNow(job: PdfJob): Promise<Buffer> {
    const browser = await this.getBrowser();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(READY_TIMEOUT_MS);
      await page.setJavaScriptEnabled(true);
      await page.setRequestInterception(true);
      page.on('request', (req) => void this.answer(req, job));
      page.on('pageerror', (e) => this.log.warn(`print page error: ${e instanceof Error ? e.message : e}`));

      await page.goto(`${PRINT_ORIGIN}/doc.html`, { waitUntil: 'load' });
      await page.waitForFunction('window.__PRINT_READY === true', { timeout: READY_TIMEOUT_MS });
      const problems = (await page.evaluate('window.__PRINT_ERRORS || []')) as string[];
      if (problems.length) this.log.warn(`print runtime reported: ${problems.join('; ')}`);

      const pdf = await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: `<div style="width:100%;font-size:8px;color:#8a93a5;padding:0 17mm"><span>${esc(job.title)}</span></div>`,
        footerTemplate:
          '<div style="width:100%;font-size:8px;color:#8a93a5;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        outline: true, // headings become PDF bookmarks
        tagged: true, // accessible structure
      });
      return Buffer.from(pdf);
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      this.log.error(`PDF rendering failed: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException('pdf_failed');
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /** Answers (or blocks) every request the print page makes. */
  private async answer(req: HTTPRequest, job: PdfJob): Promise<void> {
    try {
      const url = new URL(req.url());
      if (url.protocol === 'data:') return void (await req.continue());
      if (url.origin !== PRINT_ORIGIN) return void (await req.abort('blockedbyclient'));

      if (url.pathname === '/doc.html') {
        return void (await req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: job.html }));
      }

      if (url.pathname.startsWith('/static/')) {
        const rel = decodeURIComponent(url.pathname.slice('/static/'.length));
        const root = resolve(this.assetsDir);
        const file = resolve(root, rel);
        if (!file.startsWith(root + sep)) return void (await req.respond({ status: 404, body: '' }));
        const body = await readFile(file).catch(() => null);
        if (!body) return void (await req.respond({ status: 404, body: '' }));
        return void (await req.respond({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', body }));
      }

      if (url.pathname.startsWith('/media/')) {
        const id = url.pathname.slice('/media/'.length);
        // Only this user's own files, looked up by id: a document cannot reach anyone else's media.
        const row = UUID.test(id) ? await this.prisma.media.findFirst({ where: { id, userId: job.userId } }) : null;
        const body = row ? await readFile(this.storage.mediaPath(row.userId, row.id)).catch(() => null) : null;
        if (!row || !body) return void (await req.respond({ status: 404, body: '' }));
        return void (await req.respond({ status: 200, contentType: row.mime, body }));
      }

      await req.respond({ status: 404, body: '' });
    } catch {
      await req.abort('failed').catch(() => undefined);
    }
  }
}
