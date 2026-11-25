import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Mathematics } from '@tiptap/extension-mathematics';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { TableKit } from '@tiptap/extension-table';
import { TextAlign } from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import { Youtube } from '@tiptap/extension-youtube';
import {
  Callout,
  ChartNode,
  FunctionPlotNode,
  ImageFigure,
  MermaidNode,
  VideoNode,
  type MediaPathResolver,
} from './nodes';

export * from './nodes';
export * from './specs';
export * from './render-config';
export * from './plot';

export interface SchemaOptions {
  /**
   * A lowlight instance enables syntax highlighting in code blocks (editor only).
   * Without it the plain CodeBlock is used; the stored schema is identical.
   */
  lowlight?: unknown;
  /** Enables behaviour that only makes sense with a live view (resizable tables). */
  client?: boolean;
  /** How media is referenced in exported Markdown. Defaults to `media/<id>`. */
  mediaPath?: MediaPathResolver;
}

/** Link protocols allowed in stored documents. Mirrored by the validator. */
export const ALLOWED_LINK_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'] as const;

/**
 * The single source of truth for what a note can contain. The server uses it to validate,
 * render HTML and export Markdown; the editor uses it to build its ProseMirror schema.
 * Behaviour-only extensions (undo/redo, placeholder, node views, ...) are added by the editor.
 */
export function getSchemaExtensions(options: SchemaOptions = {}): Extensions {
  const { lowlight, client = false, mediaPath } = options;

  return [
    StarterKit.configure({
      codeBlock: lowlight ? false : {},
      undoRedo: false,
      dropcursor: false,
      gapcursor: false,
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        protocols: ['mailto', 'tel'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank', class: null },
      },
    }),
    ...(lowlight
      ? [CodeBlockLowlight.configure({ lowlight: lowlight as never, defaultLanguage: null })]
      : []),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: client } }),
    Details.configure({ persist: true }),
    DetailsSummary,
    DetailsContent,
    Mathematics,
    Youtube.configure({ inline: false, nocookie: true, controls: true, allowFullscreen: true }),
    ImageFigure.configure(mediaPath ? { mediaPath } : {}),
    VideoNode.configure(mediaPath ? { mediaPath } : {}),
    Callout,
    MermaidNode,
    ChartNode,
    FunctionPlotNode,
  ];
}
