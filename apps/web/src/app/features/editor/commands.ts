import type { Editor, JSONContent } from '@tiptap/core';
import { DEFAULT_CHART_DATA, DEFAULT_PLOT_SPEC } from '@notes/shared';
import type { SlashItem } from './slash';
import './tiptap-types';

/** What the insert commands need from the page that hosts the editor. */
export interface InsertHooks {
  pickFile(kind: 'image' | 'video'): void;
  askMath(block: boolean): void;
  askYoutube(): void;
}

/** Inserts an atom block and selects it so its edit panel opens straight away. */
function insertAtom(editor: Editor, node: JSONContent): void {
  editor.chain().focus().insertContent(node).run();
  const { selection, doc } = editor.state;
  const before = doc.resolve(selection.from).nodeBefore;
  if (before && before.type.name === node.type) editor.commands.setNodeSelection(selection.from - before.nodeSize);
}

/** Everything that can be inserted. Used by the "/" menu and the toolbar's Insert menu. */
export function buildInsertItems(hooks: InsertHooks): SlashItem[] {
  const item = (id: string, icon: string, keywords: string, run: SlashItem['run']): SlashItem => ({ id, icon, labelKey: `editor.cmd.${id}`, keywords, run });
  return [
    item('paragraph', 'notes', 'text paragraph texto paragrafo', (e) => e.chain().focus().setParagraph().run()),
    item('h1', 'looks_one', 'heading titulo h1', (e) => e.chain().focus().setHeading({ level: 1 }).run()),
    item('h2', 'looks_two', 'heading titulo h2', (e) => e.chain().focus().setHeading({ level: 2 }).run()),
    item('h3', 'looks_3', 'heading titulo h3', (e) => e.chain().focus().setHeading({ level: 3 }).run()),
    item('bulletList', 'format_list_bulleted', 'list bullets lista marcadores', (e) => e.chain().focus().toggleBulletList().run()),
    item('orderedList', 'format_list_numbered', 'list numbered lista numerada', (e) => e.chain().focus().toggleOrderedList().run()),
    item('taskList', 'checklist', 'todo task checkbox tarefas', (e) => e.chain().focus().toggleTaskList().run()),
    item('blockquote', 'format_quote', 'quote citacao', (e) => e.chain().focus().toggleBlockquote().run()),
    item('codeBlock', 'code', 'code codigo programming', (e) => e.chain().focus().toggleCodeBlock().run()),
    item('divider', 'horizontal_rule', 'divider line linha separador', (e) => e.chain().focus().setHorizontalRule().run()),
    item('table', 'table_chart', 'table tabela grid', (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
    item('callout', 'info', 'callout note aviso destaque', (e) => e.chain().focus().insertContent({ type: 'callout', attrs: { variant: 'info' }, content: [{ type: 'paragraph' }] }).run()),
    item('details', 'expand_circle_down', 'toggle details collapse recolher', (e) => e.chain().focus().setDetails().run()),
    item('image', 'image', 'image picture photo imagem foto', () => hooks.pickFile('image')),
    item('video', 'videocam', 'video film', () => hooks.pickFile('video')),
    item('mathBlock', 'functions', 'math formula equation latex matematica formula equacao', () => hooks.askMath(true)),
    item('mathInline', 'superscript', 'math inline latex formula', () => hooks.askMath(false)),
    item('mermaid', 'account_tree', 'diagram flowchart mermaid diagrama fluxograma', (e) => insertAtom(e, { type: 'mermaid', attrs: { code: 'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]' } })),
    item('chart', 'bar_chart', 'chart graph bars pie grafico', (e) => insertAtom(e, { type: 'chart', attrs: { type: 'bar', data: structuredClone(DEFAULT_CHART_DATA), options: {} } })),
    item('plot', 'show_chart', 'plot function graph expression funcao grafico', (e) => insertAtom(e, { type: 'functionPlot', attrs: { ...structuredClone(DEFAULT_PLOT_SPEC), title: '' } })),
    item('youtube', 'smart_display', 'youtube embed video', () => hooks.askYoutube()),
  ];
}
