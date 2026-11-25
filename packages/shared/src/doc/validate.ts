import { getSchema, type JSONContent } from '@tiptap/core';
import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model';
import { z } from 'zod';
import {
  ALLOWED_LINK_PROTOCOLS,
  CALLOUT_VARIANTS,
  IMAGE_ALIGNS,
  LIMITS,
  MEDIA_ID,
  chartDataSchema,
  chartOptionsSchema,
  CHART_TYPES,
  cssColorSchema,
  getSchemaExtensions,
  plotExpressionSchema,
} from '../schema';

export type ValidateResult = { ok: true; doc: JSONContent } | { ok: false; error: string };

let cachedSchema: Schema | null = null;

/** The ProseMirror schema that stored documents must conform to. */
export function getDocSchema(): Schema {
  return (cachedSchema ??= getSchema(getSchemaExtensions()));
}

const align = z.enum(['left', 'center', 'right', 'justify']).nullish();
const width = z.number().min(5).max(100).nullish();
const colour = cssColorSchema.nullish();

const youtubeSrc = z
  .string()
  .max(500)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (
        u.protocol === 'https:' &&
        ['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com', 'youtu.be'].includes(u.hostname)
      );
    } catch {
      return false;
    }
  }, 'only YouTube links can be embedded');

/** Attribute rules for node types whose attributes affect rendering, layout or security. */
const nodeRules: Record<string, z.ZodType> = {
  paragraph: z.object({ textAlign: align }),
  heading: z.object({ level: z.number().int().min(1).max(6), textAlign: align }),
  orderedList: z.object({ start: z.number().int().min(0).max(1_000_000).nullish() }),
  codeBlock: z.object({
    language: z
      .string()
      .regex(/^[A-Za-z0-9_+#.\-]{1,32}$/)
      .nullish(),
  }),
  taskItem: z.object({ checked: z.boolean() }),
  tableCell: z.object({
    colspan: z.number().int().min(1).max(100),
    rowspan: z.number().int().min(1).max(100),
    colwidth: z.array(z.number().min(0).max(5000)).nullish(),
  }),
  tableHeader: z.object({
    colspan: z.number().int().min(1).max(100),
    rowspan: z.number().int().min(1).max(100),
    colwidth: z.array(z.number().min(0).max(5000)).nullish(),
  }),
  details: z.object({ open: z.boolean().optional() }),
  youtube: z.object({
    src: youtubeSrc,
    start: z.number().int().min(0).max(1_000_000).nullish(),
    width: z.number().min(100).max(4000).nullish(),
    height: z.number().min(100).max(4000).nullish(),
  }),
  inlineMath: z.object({ latex: z.string().max(2000) }),
  blockMath: z.object({ latex: z.string().max(20_000) }),
  imageFigure: z.object({
    mediaId: MEDIA_ID,
    alt: z.string().max(LIMITS.altMax),
    caption: z.string().max(LIMITS.captionMax),
    width,
    align: z.enum(IMAGE_ALIGNS),
  }),
  video: z.object({
    mediaId: MEDIA_ID,
    posterId: MEDIA_ID.nullish(),
    caption: z.string().max(LIMITS.captionMax),
    width,
  }),
  callout: z.object({ variant: z.enum(CALLOUT_VARIANTS) }),
  mermaid: z.object({ code: z.string().max(LIMITS.mermaidMax) }),
  chart: z.object({
    type: z.enum(CHART_TYPES),
    data: chartDataSchema,
    options: chartOptionsSchema,
  }),
  functionPlot: z.object({
    expressions: z.array(plotExpressionSchema).min(1).max(LIMITS.plotMaxExpressions),
    xDomain: z.tuple([z.number(), z.number()]),
    yDomain: z.tuple([z.number(), z.number()]).nullish(),
    grid: z.boolean(),
    title: z.string().max(200),
  }),
};

export function isSafeHref(href: string): boolean {
  if (href.length > 2048) return false;
  if (href.startsWith('#') || /^\/(?!\/)/.test(href)) return true;
  try {
    return (ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

const markRules: Record<string, z.ZodType> = {
  link: z.object({ href: z.string().refine(isSafeHref, 'unsafe link') }),
  textStyle: z.object({ color: colour }),
  highlight: z.object({ color: colour }),
};

function checkAttrs(rules: Record<string, z.ZodType>, name: string, attrs: unknown): string | null {
  const rule = rules[name];
  if (!rule) return null;
  const res = rule.safeParse(attrs);
  if (res.success) return null;
  const issue = res.error.issues[0];
  return `${name}.${issue?.path.join('.') || '?'}: ${issue?.message ?? 'invalid'}`;
}

function checkMarks(marks: readonly Mark[]): string | null {
  for (const m of marks) {
    const err = checkAttrs(markRules, m.type.name, m.attrs);
    if (err) return err;
  }
  return null;
}

function walk(node: PMNode, depth: number): string | null {
  if (depth > LIMITS.docMaxDepth) return 'document is nested too deeply';
  const err = checkAttrs(nodeRules, node.type.name, node.attrs) ?? checkMarks(node.marks);
  if (err) return err;
  for (let i = 0; i < node.childCount; i++) {
    const childErr = walk(node.child(i), depth + 1);
    if (childErr) return childErr;
  }
  return null;
}

/**
 * Validates untrusted document JSON against the shared schema and attribute rules.
 * On success returns the *normalised* document (unknown attributes dropped), which is
 * what callers must store.
 */
export function validateDoc(json: unknown): ValidateResult {
  if (!json || typeof json !== 'object' || (json as JSONContent).type !== 'doc') {
    return { ok: false, error: 'document root must be of type "doc"' };
  }
  try {
    if (JSON.stringify(json).length > LIMITS.docMaxBytes) {
      return { ok: false, error: 'document is too large' };
    }
    const node = getDocSchema().nodeFromJSON(json);
    node.check();
    const err = walk(node, 0);
    if (err) return { ok: false, error: err };
    return { ok: true, doc: node.toJSON() as JSONContent };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid document' };
  }
}
