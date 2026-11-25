import type { JSONContent } from '@tiptap/core';

export interface CatRow {
  id: string;
  name: string;
  parentId: string | null;
  position: string;
}

export interface PageRow {
  id: string;
  title: string;
  categoryId: string;
  position: string;
  content: unknown;
}

export interface CatNode {
  id: string;
  name: string;
  pages: PageRow[];
  children: CatNode[];
}

/** Binary comparison on purpose: position keys are case-sensitive, the database collation is not. */
export const byPosition = <T extends { position: string }>(a: T, b: T): number =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

/** Categories nested by parent, each level and each category's pages in position order. */
export function buildForest(cats: CatRow[], pages: PageRow[]): { roots: CatNode[]; byId: Map<string, CatNode> } {
  const byId = new Map<string, CatNode>(cats.map((c) => [c.id, { id: c.id, name: c.name, pages: [], children: [] }]));
  for (const p of [...pages].sort(byPosition)) byId.get(p.categoryId)?.pages.push(p);

  const roots: CatNode[] = [];
  for (const c of [...cats].sort(byPosition)) {
    const node = byId.get(c.id)!;
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return { roots, byId };
}

export const asDoc = (content: unknown): JSONContent => content as JSONContent;

// ---------------------------------------------------------------- file names

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A name that is safe on Windows, macOS and Linux file systems and inside zip archives. */
export function safeName(raw: string, fallback: string): string {
  let name = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  if (!name) name = fallback;
  return RESERVED.test(name) ? `${name}_` : name;
}

/** Keeps names unique within one folder: "Notes", "Notes (2)", ... (case-insensitive, like the strictest file system). */
export class NameSet {
  private readonly used = new Set<string>();
  take(name: string): string {
    let candidate = name;
    for (let n = 2; this.used.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

export const extensionFor = (mime: string): string =>
  ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/ogg': '.ogv',
  })[mime] ?? '';

/** Content-Disposition value with an ASCII fallback and the real UTF-8 name. */
export function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
