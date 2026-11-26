import { Injector, type WritableSignal } from '@angular/core';
import type { Extensions, Node as TipTapNode } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import FileHandler from '@tiptap/extension-file-handler';
import { Mathematics } from '@tiptap/extension-mathematics';
import { TableOfContents, type TableOfContentData } from '@tiptap/extension-table-of-contents';
import Typography from '@tiptap/extension-typography';
import { CharacterCount, Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions';
import { all, createLowlight } from 'lowlight';
import { AngularNodeViewRenderer } from 'ngx-tiptap';
import {
  Callout,
  ChartNode,
  FunctionPlotNode,
  getSchemaExtensions,
  IMAGE_MIMES,
  ImageFigure,
  MermaidNode,
  VIDEO_MIMES,
  VideoNode,
} from '@os-planner/shared';
import { SlashCommand, type SlashState } from './slash';
import { CalloutView } from './views/callout-view';
import { ChartView } from './views/chart-view';
import { CodeBlockView } from './views/code-block-view';
import { ImageFigureView } from './views/image-figure-view';
import { MermaidView } from './views/mermaid-view';
import { PlotView } from './views/plot-view';
import { VideoView } from './views/video-view';

export type OutlineItem = TableOfContentData[number];

export interface ExtensionHooks {
  injector: Injector;
  placeholder: string;
  slash: SlashState;
  outline: WritableSignal<OutlineItem[]>;
  insertFiles(files: File[], pos?: number): void;
  editMath(type: 'inlineMath' | 'blockMath', pos: number, latex: string): void;
}

const lowlight = createLowlight(all);

/**
 * The editor's extensions: the shared schema (identical to what the server validates and prints)
 * with Angular node views attached to the custom blocks, plus the behaviour that only makes sense
 * with a live view: undo/redo, placeholder, "/" menu, file drops, outline, word count.
 */
export function buildExtensions(h: ExtensionHooks): Extensions {
  // Same node, same attributes, same HTML: only a view is added.
  const views: Record<string, TipTapNode> = {
    imageFigure: ImageFigure.extend({ addNodeView: () => AngularNodeViewRenderer(ImageFigureView, { injector: h.injector }) }),
    video: VideoNode.extend({ addNodeView: () => AngularNodeViewRenderer(VideoView, { injector: h.injector }) }),
    callout: Callout.extend({ addNodeView: () => AngularNodeViewRenderer(CalloutView, { injector: h.injector }) }),
    mermaid: MermaidNode.extend({ addNodeView: () => AngularNodeViewRenderer(MermaidView, { injector: h.injector }) }),
    chart: ChartNode.extend({ addNodeView: () => AngularNodeViewRenderer(ChartView, { injector: h.injector }) }),
    functionPlot: FunctionPlotNode.extend({ addNodeView: () => AngularNodeViewRenderer(PlotView, { injector: h.injector }) }),
  };

  const schema = getSchemaExtensions({ client: true, lowlight }).map((ext) => {
    if (ext.name in views) return views[ext.name]!;
    if (ext.name === 'codeBlock') {
      return CodeBlockLowlight.extend({ addNodeView: () => AngularNodeViewRenderer(CodeBlockView, { injector: h.injector }) }).configure({ lowlight, defaultLanguage: null });
    }
    if (ext.name === 'Mathematics') {
      return Mathematics.configure({
        katexOptions: { throwOnError: false },
        inlineOptions: { onClick: (node, pos) => h.editMath('inlineMath', pos, node.attrs['latex']) },
        blockOptions: { onClick: (node, pos) => h.editMath('blockMath', pos, node.attrs['latex']) },
      });
    }
    return ext;
  });

  return [
    ...schema,
    UndoRedo,
    Dropcursor.configure({ color: 'var(--accent)', width: 2 }),
    Gapcursor,
    Typography,
    CharacterCount,
    Placeholder.configure({ placeholder: h.placeholder }),
    TableOfContents.configure({ onUpdate: (content) => h.outline.set(content) }),
    SlashCommand(h.slash),
    FileHandler.configure({
      allowedMimeTypes: [...IMAGE_MIMES, ...VIDEO_MIMES],
      onDrop: (_editor, files, pos) => h.insertFiles(files, pos),
      onPaste: (_editor, files, html) => {
        if (html) return false; // pasting from a web page: keep the page's own content handling
        h.insertFiles(files);
        return true;
      },
    }),
  ];
}
