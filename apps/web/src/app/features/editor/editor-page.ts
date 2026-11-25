import { Component, DestroyRef, ElementRef, Injector, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Editor, isTextSelection } from '@tiptap/core';
import { liveQuery } from 'dexie';
import { TiptapBubbleMenuDirective, TiptapEditorDirective } from 'ngx-tiptap';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoPipe } from '@jsverse/transloco';
import type { JSONContent } from '@tiptap/core';
import { isSafeHref } from '@notes/shared';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { Online } from '../../core/online';
import { Db } from '../../data/db';
import { MediaStore } from '../../data/media-store';
import { PageStore } from '../../data/page-store';
import { Sync } from '../../data/sync';
import { TreeStore } from '../../data/tree-store';
import { Dialogs } from '../../shared/dialogs';
import { ExportDialog } from '../export/export-dialog';
import { buildInsertItems } from './commands';
import { buildExtensions, type OutlineItem } from './editor-extensions';
import { SlashState } from './slash';
import { Toolbar } from './toolbar';
import './tiptap-types';

/** localStorage key prefix for unsaved drafts written as the page unloads. */
export const DRAFT_PREFIX = 'notes.draft.';
const AUTOSAVE_MS = 700;
const RENAME_MS = 500;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

@Component({
  selector: 'app-editor-page',
  imports: [RouterLink, TiptapEditorDirective, TiptapBubbleMenuDirective, Toolbar, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslocoPipe],
  templateUrl: './editor-page.html',
  styleUrl: './editor-page.scss',
})
export class EditorPage implements OnDestroy {
  /** Bound from the route (`/app/p/:id`). */
  readonly id = input.required<string>();

  private readonly injector = inject(Injector);
  private readonly tree = inject(TreeStore);
  private readonly pages = inject(PageStore);
  private readonly media = inject(MediaStore);
  private readonly dbs = inject(Db);
  private readonly sync = inject(Sync);
  private readonly online = inject(Online);
  private readonly dialogs = inject(Dialogs);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly lang = inject(Language);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly meta = computed(() => this.tree.pageById().get(this.id()));
  readonly trashed = computed(() => !!this.meta()?.deletedAt);
  readonly crumbs = computed(() => {
    const m = this.meta();
    if (!m) return null;
    return { notebook: this.tree.notebookById().get(m.notebookId), category: this.tree.categoryById().get(m.categoryId) };
  });

  readonly editor = signal<Editor | null>(null);
  readonly loading = signal(true);
  readonly missing = signal(false);
  readonly outline = signal<OutlineItem[]>([]);
  readonly showOutline = signal(false);
  readonly typing = signal(false);
  private readonly stats = signal({ words: 0, characters: 0 });
  readonly words = computed(() => this.stats().words);
  readonly characters = computed(() => this.stats().characters);

  /** Saved → Saving → Saved offline. Derived from the sync queue plus whether a local save is pending. */
  readonly saveState = computed<'saved' | 'saving' | 'offline'>(() => {
    if (!this.typing() && this.sync.pending() === 0) return 'saved';
    return this.online.isOnline() ? 'saving' : 'offline';
  });

  readonly slash = new SlashState(
    () => this.insertItems,
    (key) => this.lang.t(key),
  );
  readonly insertItems = buildInsertItems({
    pickFile: (kind) => this.pickFile(kind),
    askMath: (block) => void this.askMath(block),
    askYoutube: () => void this.askYoutube(),
  });

  /** The floating format bar appears for a text selection only (not for a selected image or diagram). */
  readonly bubbleShouldShow = ({ editor, from, to }: { editor: Editor; from: number; to: number }): boolean =>
    editor.isEditable && from !== to && isTextSelection(editor.state.selection) && !editor.isActive('codeBlock');

  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  private pendingKind: 'image' | 'video' = 'image';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private renameTimer: ReturnType<typeof setTimeout> | null = null;
  /** Dexie's liveQuery subscription (not an RxJS one). */
  private watching: { unsubscribe(): void } | null = null;
  private loadedId: string | null = null;
  private loadedBase = -1;
  private titleEdited = false;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.open(id));
    });

    // Closing, reloading or switching away from the tab must not lose what was typed in the last moments.
    // IndexedDB writes are asynchronous and can be cut off as a page unloads, so a draft is also written
    // to localStorage, which is synchronous. open() recovers it. (Cleared again once the database has it.)
    const rescue = () => {
      this.writeDraft();
      void this.flush();
    };
    const onHidden = () => document.visibilityState === 'hidden' && rescue();
    addEventListener('pagehide', rescue);
    document.addEventListener('visibilitychange', onHidden);
    inject(DestroyRef).onDestroy(() => {
      removeEventListener('pagehide', rescue);
      document.removeEventListener('visibilitychange', onHidden);
    });
    // The title input follows the stored title (it can change on another device), unless the person
    // has typed in it since this page opened: then their text wins until it is saved.
    effect(() => {
      const title = this.meta()?.title ?? '';
      const input = this.titleInput()?.nativeElement;
      if (input && !this.titleEdited && input.value !== title) input.value = title;
    });
  }

  ngOnDestroy(): void {
    void this.flush();
    this.closeEditor();
  }

  // ------------------------------------------------------------------ opening

  private async open(id: string): Promise<void> {
    await this.flush();
    this.closeEditor();
    this.titleEdited = false;
    this.loading.set(true);
    this.missing.set(false);
    this.outline.set([]);

    let row = await this.pages.load(id);
    if (this.id() !== id) return; // navigated away while loading
    const draft = row ? this.takeDraft(id) : null;
    if (row && draft) {
      // The tab was closed before the last edits reached the database: they are newer than what is stored.
      await this.pages.saveContent(id, draft);
      row = (await this.pages.load(id)) ?? row;
    }
    if (!row) {
      this.loading.set(false);
      this.missing.set(!this.meta());
      return;
    }

    this.loadedId = id;
    this.loadedBase = row.baseVersion;
    const editor = new Editor({
      extensions: buildExtensions({
        injector: this.injector,
        placeholder: this.lang.t('editor.placeholder'),
        slash: this.slash,
        outline: this.outline,
        insertFiles: (files, pos) => void this.insertFiles(files, pos),
        editMath: (type, pos, latex) => void this.editMath(type, pos, latex),
      }),
      content: row.content as JSONContent,
      editable: !this.trashed(),
      editorProps: { attributes: { class: 'doc', spellcheck: 'true' } },
      onUpdate: () => this.onEdit(),
      onCreate: ({ editor: e }) => this.updateStats(e),
    });
    this.editor.set(editor);
    this.loading.set(false);
    this.watchRemote(id);

    if (this.route.snapshot.queryParamMap.get('focus') === 'title') queueMicrotask(() => this.titleInput()?.nativeElement.focus());
    else if (!this.trashed()) queueMicrotask(() => editor.commands.focus('end'));
  }

  private closeEditor(): void {
    this.watching?.unsubscribe();
    this.watching = null;
    this.editor()?.destroy();
    this.editor.set(null);
    this.slash.close();
  }

  /** Content that changed underneath us (another device synced, or a conflict was resolved) replaces what is on screen. */
  private watchRemote(id: string): void {
    this.watching = liveQuery(() => this.dbs.db.contents.get(id)).subscribe((row) => {
      const editor = this.editor();
      if (!row || !editor || this.loadedId !== id || row.dirty) return;
      // Edits still waiting for the autosave are newer than whatever a sync round-trip just stored; replacing
      // the document now would throw them away (a sync that finishes while someone types would undo the edit).
      if (this.typing()) return;
      if (row.baseVersion === this.loadedBase) return;
      this.loadedBase = row.baseVersion;
      if (same(row.content, editor.getJSON())) return; // our own save coming back
      editor.commands.setContent(row.content as JSONContent, { emitUpdate: false });
      this.notify.info('editor.updatedElsewhere');
    });
  }

  // ------------------------------------------------------------------ saving

  private onEdit(): void {
    const editor = this.editor();
    if (editor) this.updateStats(editor);
    this.typing.set(true);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
  }

  private updateStats(editor: Editor): void {
    const c = editor.storage['characterCount'] as { words(): number; characters(): number } | undefined;
    if (c) this.stats.set({ words: c.words(), characters: c.characters() });
  }

  /** Writes the editor's current document to the local database right now. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const editor = this.editor();
    const id = this.loadedId;
    if (editor && id && this.typing()) {
      const snapshot = editor.getJSON() as JSONContent;
      await this.pages.saveContent(id, snapshot);
      // An edit made while the save was in flight is not in the snapshot: it stays "unsaved" and has its own timer.
      if (!same(editor.getJSON(), snapshot)) return;
      this.clearDraft(id);
    }
    this.typing.set(false);
  }

  // ---- crash-proof drafts (see the constructor)
  private writeDraft(): void {
    const editor = this.editor();
    if (!editor || !this.loadedId || !this.typing()) return;
    try {
      localStorage.setItem(DRAFT_PREFIX + this.loadedId, JSON.stringify(editor.getJSON()));
    } catch {
      /* storage full or unavailable: the asynchronous save is still attempted */
    }
  }
  private clearDraft(id: string): void {
    try {
      localStorage.removeItem(DRAFT_PREFIX + id);
    } catch {
      /* ignore */
    }
  }
  private takeDraft(id: string): JSONContent | null {
    try {
      const raw = localStorage.getItem(DRAFT_PREFIX + id);
      if (!raw) return null;
      localStorage.removeItem(DRAFT_PREFIX + id);
      return JSON.parse(raw) as JSONContent;
    } catch {
      return null;
    }
  }

  saveNow(event: Event): void {
    event.preventDefault();
    void this.flush().then(() => void this.sync.run());
  }

  onTitle(value: string): void {
    this.titleEdited = true;
    if (this.renameTimer) clearTimeout(this.renameTimer);
    const id = this.id();
    this.renameTimer = setTimeout(async () => {
      await this.tree.renamePage(id, value.trim());
      if (this.id() === id) this.titleEdited = false; // stored: the input may follow the database again
    }, RENAME_MS);
  }

  /** Enter in the title moves into the text. Focus is set synchronously so typing right away is not lost. */
  focusBody(): void {
    const editor = this.editor();
    if (!editor) return;
    editor.view.focus();
    editor.commands.setTextSelection(1);
  }

  // ------------------------------------------------------------------ inserting things

  pickFile(kind: 'image' | 'video'): void {
    this.pendingKind = kind;
    const input = this.fileInput()?.nativeElement;
    if (!input) return;
    input.accept = kind === 'image' ? 'image/png,image/jpeg,image/webp,image/gif,image/avif' : 'video/mp4,video/webm,video/ogg';
    input.value = '';
    input.click();
  }

  onFilesPicked(event: Event): void {
    const files = [...((event.target as HTMLInputElement).files ?? [])];
    if (files.length) void this.insertFiles(files);
  }

  async insertFiles(files: File[], pos?: number): Promise<void> {
    const editor = this.editor();
    if (!editor) return;
    for (const file of files) {
      try {
        const added = await this.media.add(file);
        const node =
          added.kind === 'image'
            ? { type: 'imageFigure', attrs: { mediaId: added.id, alt: file.name.replace(/\.[^.]+$/, ''), caption: '', width: null, align: 'center' } }
            : { type: 'video', attrs: { mediaId: added.id, posterId: added.posterId, caption: '', width: null } };
        editor.chain().focus().insertContentAt(pos ?? editor.state.selection.to, node).run();
      } catch {
        this.notify.error('editor.unsupportedFile', { name: file.name });
      }
    }
  }

  private async askMath(block: boolean): Promise<void> {
    const result = await this.dialogs.math({ latex: '', block, isNew: true });
    if (result?.action !== 'save') return;
    this.editor()?.chain().focus().insertContent({ type: block ? 'blockMath' : 'inlineMath', attrs: { latex: result.latex } }).run();
  }

  private async editMath(type: 'inlineMath' | 'blockMath', pos: number, latex: string): Promise<void> {
    const editor = this.editor();
    if (!editor || this.trashed()) return;
    const result = await this.dialogs.math({ latex, block: type === 'blockMath', isNew: false });
    if (!result) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    const tr = editor.state.tr;
    if (result.action === 'delete') tr.delete(pos, pos + node.nodeSize);
    else tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: result.latex });
    editor.view.dispatch(tr);
  }

  private async askYoutube(): Promise<void> {
    const result = await this.dialogs.prompt({
      titleKey: 'editor.youtubeTitle',
      labelKey: 'editor.youtubeLabel',
      placeholder: 'https://www.youtube.com/watch?v=…',
      validate: (v) => (/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//.test(v) ? null : 'editor.youtubeInvalid'),
    });
    if (result?.action === 'ok') this.editor()?.chain().focus().setYoutubeVideo({ src: result.value }).run();
  }

  async editLink(): Promise<void> {
    const editor = this.editor();
    if (!editor) return;
    const current = (editor.getAttributes('link')['href'] as string | undefined) ?? '';
    const result = await this.dialogs.prompt({
      titleKey: 'editor.linkTitle',
      labelKey: 'editor.linkLabel',
      value: current,
      placeholder: 'https://',
      secondaryKey: current ? 'editor.removeLink' : undefined,
      validate: (v) => (v && isSafeHref(normaliseHref(v)) ? null : 'editor.linkInvalid'),
    });
    if (!result) return;
    if (result.action === 'secondary') editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: normaliseHref(result.value) }).run();
  }

  scrollTo(item: OutlineItem): void {
    const el = document.querySelector(`[data-toc-id="${item.id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ------------------------------------------------------------------ page actions

  export(): void {
    const m = this.meta();
    if (!m) return;
    void this.flush().then(() => this.dialog.open(ExportDialog, { data: { scope: 'page', id: m.id, name: m.title || this.lang.t('page.untitled') }, width: '440px' }));
  }

  async trash(): Promise<void> {
    const m = this.meta();
    if (!m) return;
    await this.flush();
    await this.tree.deletePage(m.id);
    await this.router.navigate(['/app']);
    this.notify.info('page.deleted', {}, { key: 'common.undo', run: () => void this.tree.restorePage(m.id) });
  }

  async restore(): Promise<void> {
    await this.tree.restorePage(this.id());
    this.editor()?.setEditable(true);
  }
}

/** "example.com" is what people type; make it a real URL. */
function normaliseHref(v: string): string {
  return /^[a-z][a-z0-9+.-]*:|^[#/]/i.test(v) ? v : /^[^\s]+\.[^\s]+$/.test(v) ? `https://${v}` : v;
}
