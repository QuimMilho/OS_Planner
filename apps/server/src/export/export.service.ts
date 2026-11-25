import { Injectable, NotFoundException } from '@nestjs/common';
import type { Writable } from 'node:stream';
import {
  collectMediaIds,
  docToMarkdown,
  PRINT_LABELS,
  renderPrintHtml,
  type ExportPdfInput,
  type ExportScope,
  type PrintEntry,
} from '@notes/shared';
import { StorageService } from '../media/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { asDoc, buildForest, extensionFor, NameSet, safeName, type CatNode, type PageRow } from './forest.js';
import { PdfService, PRINT_ASSETS_BASE, printMediaUrl } from './pdf.service.js';
import { ZipWriter } from './zip.js';

/** What was asked for, loaded and arranged for rendering. */
interface Selection {
  scope: ExportScope;
  name: string;
  /** Notebook name for categories and pages (shown under the title). */
  context?: string;
  /** Categories to export, in order. Empty for a single page. */
  roots: CatNode[];
  /** Set when exporting a single page. */
  page?: PageRow;
}

export type MarkdownExport =
  | { kind: 'md'; filename: string; text: string }
  | { kind: 'zip'; filename: string; write: (out: Writable) => Promise<void> };

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly pdf: PdfService,
  ) {}

  // ---------------------------------------------------------------- selection

  private async select(userId: string, scope: ExportScope, id: string): Promise<Selection> {
    if (scope === 'page') {
      const page = await this.prisma.page.findFirst({
        where: { id, userId, deletedAt: null },
        select: { id: true, title: true, categoryId: true, position: true, content: true, notebook: { select: { name: true } } },
      });
      if (!page) throw new NotFoundException();
      return { scope, name: page.title, context: page.notebook.name, roots: [], page };
    }

    let notebookId: string;
    let categoryId: string | undefined;
    if (scope === 'category') {
      const cat = await this.prisma.category.findFirst({ where: { id, userId, deletedAt: null }, select: { notebookId: true } });
      if (!cat) throw new NotFoundException();
      notebookId = cat.notebookId;
      categoryId = id;
    } else {
      notebookId = id;
    }

    const notebook = await this.prisma.notebook.findFirst({ where: { id: notebookId, userId, deletedAt: null } });
    if (!notebook) throw new NotFoundException();
    const [cats, pages] = await Promise.all([
      this.prisma.category.findMany({
        where: { notebookId, userId, deletedAt: null },
        select: { id: true, name: true, parentId: true, position: true },
      }),
      this.prisma.page.findMany({
        where: { notebookId, userId, deletedAt: null },
        select: { id: true, title: true, categoryId: true, position: true, content: true },
      }),
    ]);
    const { roots, byId } = buildForest(cats, pages);

    if (categoryId) {
      const node = byId.get(categoryId)!;
      return { scope, name: node.name, context: notebook.name, roots: [node] };
    }
    return { scope, name: notebook.name, roots };
  }

  // ---------------------------------------------------------------- PDF

  /** Category dividers and pages in reading order: a category's own pages, then its subcategories. */
  private entries(roots: CatNode[], depth = 0): PrintEntry[] {
    return roots.flatMap((c) => [
      { kind: 'category' as const, id: c.id, name: c.name, depth },
      ...c.pages.map((p) => ({ kind: 'page' as const, id: p.id, title: p.title, doc: asDoc(p.content), depth: depth + 1 })),
      ...this.entries(c.children, depth + 1),
    ]);
  }

  async pdfFor(userId: string, input: ExportPdfInput): Promise<{ buffer: Buffer; filename: string }> {
    const sel = await this.select(userId, input.scope, input.id);
    const labels = PRINT_LABELS[input.locale];
    const single = sel.scope === 'page';

    const html = renderPrintHtml({
      title: sel.name || labels.untitled,
      subtitle: single ? undefined : sel.scope === 'notebook' ? labels.notebook : `${sel.context} › ${labels.category}`,
      entries: single
        ? [{ kind: 'page', id: sel.page!.id, title: sel.page!.title, doc: asDoc(sel.page!.content), depth: 0 }]
        : this.entries(sel.roots),
      locale: input.locale,
      pageSize: input.pageSize,
      cover: !single,
      includeToc: input.includeToc && !single,
      mediaUrl: printMediaUrl,
      assetsBase: PRINT_ASSETS_BASE,
    });

    const buffer = await this.pdf.render({ userId, html, pageSize: input.pageSize, title: sel.name });
    return { buffer, filename: `${safeName(sel.name, labels.untitled)}.pdf` };
  }

  // ---------------------------------------------------------------- Markdown

  async markdownFor(userId: string, scope: ExportScope, id: string): Promise<MarkdownExport> {
    const sel = await this.select(userId, scope, id);
    const rootName = safeName(sel.name, 'Notes');

    // Lay the pages out as files first, so every page knows how deep it sits (for relative media links).
    interface FileEntry { path: string; depth: number; page: PageRow }
    const files: FileEntry[] = [];

    /** A category's pages go in `dir`; each subcategory becomes a sub-folder. */
    const walk = (cat: CatNode, dir: string[]) => {
      const names = new NameSet();
      for (const p of cat.pages) files.push({ path: [...dir, `${names.take(safeName(p.title, 'Untitled'))}.md`].join('/'), depth: dir.length, page: p });
      const folders = new NameSet();
      for (const child of cat.children) walk(child, [...dir, folders.take(safeName(child.name, 'Category'))]);
    };

    if (sel.page) {
      files.push({ path: `${safeName(sel.page.title, 'Untitled')}.md`, depth: 0, page: sel.page });
    } else if (sel.scope === 'category') {
      walk(sel.roots[0]!, []);
    } else {
      const folders = new NameSet();
      for (const c of sel.roots) walk(c, [folders.take(safeName(c.name, 'Category'))]);
    }

    // Which uploads do these pages use? They go into media/ next to the pages.
    const wanted = [...new Set(files.flatMap((f) => collectMediaIds(asDoc(f.page.content))))];
    const media = wanted.length ? await this.prisma.media.findMany({ where: { id: { in: wanted }, userId } }) : [];
    const fileName = new Map(media.map((m) => [m.id, `${m.id}${extensionFor(m.mime)}`]));

    const markdownOf = (f: FileEntry) =>
      docToMarkdown(asDoc(f.page.content), { mediaPath: (mid) => `${'../'.repeat(f.depth)}media/${fileName.get(mid) ?? mid}` });

    // One page without media is just a .md file.
    if (sel.page && !media.length) {
      return { kind: 'md', filename: `${safeName(sel.page.title, 'Untitled')}.md`, text: markdownOf(files[0]!) };
    }

    return {
      kind: 'zip',
      filename: `${rootName}.zip`,
      write: async (out) => {
        const zip = new ZipWriter(out);
        for (const f of files) await zip.addText(`${rootName}/${f.path}`, markdownOf(f));
        for (const m of media) await zip.addFile(`${rootName}/media/${fileName.get(m.id)}`, this.storage.mediaPath(userId, m.id));
        zip.end();
      },
    };
  }
}
