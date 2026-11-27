import { Component, DestroyRef, ElementRef, Injector, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Editor, isTextSelection } from '@tiptap/core';
import { TiptapBubbleMenuDirective, TiptapEditorDirective } from 'ngx-tiptap';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoPipe } from '@jsverse/transloco';
import type { JSONContent } from '@tiptap/core';
import { isBlankDoc } from '@os-planner/shared/lite';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { Transaction } from '@tiptap/pm/state';
import { collabColor, isSafeHref, Permission } from '@os-planner/shared';
import { apiBase } from '../../core/api-config';
import { AuthStore } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { AppUpdates } from '../../core/app-updates';
import { Notify } from '../../core/notify';
import { Online } from '../../core/online';
import { AccessStore } from '../../data/access-store';
import { MediaStore } from '../../data/media-store';
import { PageStore } from '../../data/page-store';
import { Sync } from '../../data/sync';
import { TreeStore } from '../../data/tree-store';
import { Dialogs } from '../../shared/dialogs';
import { ExportDialog } from '../export/export-dialog';
import { buildInsertItems } from './commands';
import { CollabSession } from './collab-session';
import { SnapshotsDialog } from './snapshots-dialog';
import { buildExtensions, type OutlineItem } from './editor-extensions';
import { SlashState } from './slash';
import { Toolbar } from './toolbar';
import './tiptap-types';

/** The copy of the page text kept for search, export and the preview follows what is on screen this long after the last change. */
const CACHE_MS = 700;
const RENAME_MS = 500;
/** An empty page waits this long for the server's version before it is edited (a page that has text is shown, read-only, until it arrives). */
const FIRST_SYNC_WAIT_MS = 1500;
/** A page with no text: nothing a person typed can be lost by showing it empty. */
const isEmptyDoc = (doc: unknown): boolean => isBlankDoc(doc as JSONContent | null);

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
  private readonly access = inject(AccessStore);
  private readonly pages = inject(PageStore);
  private readonly media = inject(MediaStore);
  private readonly auth = inject(AuthStore);
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
  /** Whether the person may change this page at all (a shared or team notebook can be read-only for them; a trashed page is too). */
  readonly mayEdit = computed(() => {
    const m = this.meta();
    return !!m && this.access.canEdit(m.notebookId);
  });
  readonly mayDelete = computed(() => {
    const m = this.meta();
    return !!m && this.access.can(m.notebookId, Permission.DELETE_PAGES);
  });
  /** The co-editing connection of the open page (every page is co-edited, even when only one person is in it). */
  readonly session = signal<CollabSession | null>(null);
  /** The page is shown from this device's copy while the server's version is awaited: nothing can be typed yet. */
  readonly preview = signal(false);
  /** The server said this person may only read the page (their rights were checked there, with the same rules as here). */
  readonly serverReadOnly = computed(() => this.session()?.scope() === 'readonly');
  /** Nothing can be typed: the page is in the trash, the person only reads it, or it has not been loaded for editing yet. */
  readonly readOnly = computed(() => this.trashed() || !this.mayEdit() || this.serverReadOnly() || this.preview());
  /** Read-only because of what the person may do (not because of the trash): the banner says so. */
  readonly noWriteAccess = computed(() => !this.trashed() && !!this.meta() && (!this.mayEdit() || this.serverReadOnly()));
  /** Live · Offline · Reconnecting. */
  readonly connection = computed(() => this.session()?.status() ?? 'connecting');
  /** The other people in the page right now (each person once, however many tabs they have open). */
  readonly peers = computed(() => this.session()?.peers() ?? []);
  readonly refusal = computed(() => this.session()?.refusal() ?? null);
  /** Changes made here that the server has not confirmed yet, while there is no connection to it. */
  readonly pendingOffline = computed(() => (this.session()?.unsynced() ?? 0) > 0 && this.connection() !== 'live');
  /** Whoever manages the notebook may look at earlier versions and bring one back. */
  readonly mayRestore = computed(() => {
    const m = this.meta();
    return !!m && !this.trashed() && this.access.can(m.notebookId, Permission.MANAGE_NOTEBOOKS);
  });
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
  /** Changes made here are on their way to the server's database (see settle()). */
  private readonly storing = signal(false);
  private readonly stats = signal({ words: 0, characters: 0 });
  readonly words = computed(() => this.stats().words);
  readonly characters = computed(() => this.stats().characters);

  /** Saved → Saving → Saved offline. Derived from what the server has not confirmed yet plus the queue of other changes. */
  readonly saveState = computed<'saved' | 'saving' | 'offline'>(() => {
    const unsynced = this.session()?.unsynced() ?? 0;
    if (!this.typing() && !this.storing() && unsynced === 0 && this.sync.pending() === 0) return 'saved';
    return this.online.isOnline() && this.connection() !== 'offline' ? 'saving' : 'offline';
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
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private renameTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedId: string | null = null;
  /** The text on screen has changed since it was last copied to this device's database. */
  private cacheDirty = false;
  /** Somebody typed here since the server was last asked to store the page. */
  private localDirty = false;
  private titleEdited = false;
  private focusWhenEditable = false;
  private focusBodyPending = false;

  constructor() {
    // An update's reload waits while typing is still on its way to the server. Edits made offline are kept on this device and do not hold it.
    inject(AppUpdates).holdWhile(() => this.typing() || ((this.session()?.unsynced() ?? 0) > 0 && this.connection() === 'live'));
    effect(() => {
      const id = this.id();
      untracked(() => void this.open(id));
    });

    // What is typed is in the page's own local database (IndexedDB) from the first keystroke and goes to the server over
    // the co-editing connection; closing, reloading or switching away only needs the copy kept for search and export to follow.
    const rescue = () => {
      this.session()?.backup();
      void this.flush();
    };
    const onHidden = () => document.visibilityState === 'hidden' && rescue();
    addEventListener('pagehide', rescue);
    document.addEventListener('visibilitychange', onHidden);
    inject(DestroyRef).onDestroy(() => {
      removeEventListener('pagehide', rescue);
      document.removeEventListener('visibilitychange', onHidden);
    });
    // The server's version of a page that was shown from this device's copy has arrived: now it can be edited.
    effect(() => {
      const session = this.session();
      if (session && this.preview() && session.everSynced()) untracked(() => this.startEditor());
    });
    // Changes made while there was no connection reach the server when it is back: it is asked to write them down too.
    effect(() => {
      const synced = this.session()?.syncedCount() ?? 0;
      if (!synced) return;
      untracked(() => {
        this.localDirty = true;
        void this.settle();
      });
    });
    // A page taken out of the trash is connected again: the server said "read-only" while it was there, and says it anew.
    let wasTrashed = false;
    effect(() => {
      const trashed = this.trashed();
      untracked(() => {
        if (wasTrashed && !trashed) this.session()?.retryNow();
        wasTrashed = trashed;
      });
    });
    // A page made on this device while offline reaches the server with the queue; the server did not know it until then.
    effect(() => {
      if (this.sync.pending() !== 0) return;
      untracked(() => {
        const session = this.session();
        if (session?.denied()) session.retryNow();
      });
    });
    // Rights can change while the page is open (the owner turns a share into read-only): the editor follows at once.
    effect(() => {
      const editable = !this.readOnly();
      const editor = this.editor();
      untracked(() => {
        if (!editor || editor.isEditable === editable) return;
        editor.setEditable(editable);
        // The page opened before the person's rights were known (still loading): it is theirs to type in now.
        if (editable && this.focusWhenEditable) {
          this.focusWhenEditable = false;
          queueMicrotask(() => editor.commands.focus('end'));
        }
      });
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
    this.focusWhenEditable = false;
    this.focusBodyPending = false;
    this.loading.set(true);
    this.missing.set(false);
    this.outline.set([]);

    let row = await this.pages.load(id);
    if (this.id() !== id) return; // navigated away while loading
    if (row?.dirty && this.online.isOnline()) {
      // Text saved by a version of the app that predates co-editing and not sent yet: send it the old way, before anybody is in the page.
      await this.sync.run();
      row = (await this.pages.load(id)) ?? row;
      if (this.id() !== id) return;
    }
    const userId = this.auth.userId();
    if (!row || !userId) {
      this.loading.set(false);
      this.missing.set(!this.meta());
      return;
    }

    this.loadedId = id;
    const session = new CollabSession({
      pageId: id,
      userId,
      apiBase: apiBase(),
      token: () => this.freshToken(),
      beforeMerge: (state) => void this.pages.saveLocalSnapshot(id, state),
    });
    this.session.set(session);
    await session.localReady;
    if (this.id() !== id || this.session() !== session) return;

    if (!session.isEmpty) this.startEditor();
    else if (isEmptyDoc(row.content)) {
      // Nothing to lose by editing at once. A page nobody has written to (as far as this device knows: a page just made here) is
      // edited right away; so is any page while offline. Otherwise the server's version, if somebody wrote to it elsewhere, is awaited a moment.
      const neverWritten = (this.meta()?.version ?? 0) === 0;
      if (neverWritten || !this.online.isOnline()) this.startEditor();
      else {
        this.startPreview(row.content as JSONContent);
        this.waitTimer = setTimeout(() => this.session() === session && this.preview() && this.startEditor(), FIRST_SYNC_WAIT_MS);
      }
    } else this.startPreview(row.content as JSONContent); // opened for the first time here: read-only until the server's version arrives
  }

  /** The copy of the page this device holds, shown until the shared document is ready. */
  private startPreview(content: JSONContent): void {
    this.destroyEditor();
    this.preview.set(true);
    this.editor.set(this.newEditor({ content, editable: false }));
    this.loading.set(false);
  }

  /** The editor bound to the shared document. */
  private startEditor(): void {
    const session = this.session();
    if (!session) return;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.destroyEditor();
    this.preview.set(false);
    const name = this.auth.user()?.displayName ?? '';
    const userId = this.auth.userId() ?? '';
    const editor = this.newEditor({ collab: { doc: session.doc, provider: session.provider, user: { name, color: collabColor(userId) } }, editable: !this.readOnly() });
    this.editor.set(editor);
    this.loading.set(false);
    // The copy kept for search and export starts from what the shared document holds.
    this.cacheDirty = true;
    this.scheduleCache();

    if (this.focusBodyPending) {
      this.focusBodyPending = false;
      if (!this.readOnly()) this.focusBody();
    } else if (this.route.snapshot.queryParamMap.get('focus') === 'title') queueMicrotask(() => this.titleInput()?.nativeElement.focus());
    else if (!this.readOnly()) queueMicrotask(() => editor.commands.focus('end'));
    else this.focusWhenEditable = !this.trashed();
  }

  private newEditor(options: { content?: JSONContent; editable: boolean; collab?: Parameters<typeof buildExtensions>[0]['collab'] }): Editor {
    return new Editor({
      extensions: buildExtensions({
        injector: this.injector,
        placeholder: this.lang.t('editor.placeholder'),
        slash: this.slash,
        outline: this.outline,
        insertFiles: (files, pos) => void this.insertFiles(files, pos),
        editMath: (type, pos, latex) => void this.editMath(type, pos, latex),
        collab: options.collab,
      }),
      ...(options.content ? { content: options.content } : {}),
      editable: options.editable,
      editorProps: { attributes: { class: 'doc', spellcheck: 'true', 'aria-label': this.lang.t('editor.document'), 'aria-multiline': 'true' } },
      onUpdate: ({ transaction }) => this.onEdit(transaction),
      onCreate: ({ editor: e }) => this.updateStats(e),
    });
  }

  private async freshToken(): Promise<string> {
    if (this.auth.tokenExpiresAt() - Date.now() < 30_000) await this.auth.refresh();
    return this.auth.getToken() ?? '';
  }

  private destroyEditor(): void {
    this.editor()?.destroy();
    this.editor.set(null);
    this.slash.close();
  }

  private closeEditor(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.destroyEditor();
    this.preview.set(false);
    this.session()?.destroy();
    this.session.set(null);
    this.loadedId = null;
  }

  // ------------------------------------------------------------------ keeping this device's copy

  private onEdit(tr: Transaction): void {
    const editor = this.editor();
    if (editor) this.updateStats(editor);
    if (this.preview() || this.readOnly()) return;
    this.cacheDirty = true;
    // A change that came from another person is not "typing" here (and is not the server's to be asked about).
    if (!(tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin) {
      this.typing.set(true);
      this.localDirty = true;
    }
    this.scheduleCache();
  }

  private scheduleCache(): void {
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => void this.settle(), CACHE_MS);
  }

  /**
   * A pause in typing: the copy kept on this device is brought up to date and the server is asked to write the page to its
   * database now instead of in a couple of seconds, so that "Saved" means a search, an export or another device has it.
   * (Without a connection that is skipped: the changes are safe in this device's local document.)
   */
  private async settle(): Promise<void> {
    const ask = this.localDirty;
    this.localDirty = false;
    if (ask) this.storing.set(true);
    try {
      await this.flush();
      if (ask) await this.session()?.flushToServer(3000);
    } finally {
      this.storing.set(false);
    }
  }

  private updateStats(editor: Editor): void {
    const c = editor.storage['characterCount'] as { words(): number; characters(): number } | undefined;
    if (c) this.stats.set({ words: c.words(), characters: c.characters() });
  }

  /** Copies the text on screen to this device's database right now (search, export and the preview read it from there). */
  async flush(): Promise<void> {
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    const editor = this.editor();
    const id = this.loadedId;
    if (editor && id && this.cacheDirty && !this.preview()) {
      this.cacheDirty = false;
      await this.pages.cacheContent(id, editor.getJSON() as JSONContent);
    }
    this.typing.set(false);
  }

  /** Also makes sure the server has written the page to its database (a search, an export or another device reads it from there). */
  private async flushToServer(): Promise<void> {
    await this.flush();
    await this.session()?.flushToServer();
  }

  saveNow(event: Event): void {
    event.preventDefault();
    void this.flushToServer().then(() => void this.sync.run());
  }

  onTitle(value: string): void {
    if (this.readOnly()) return;
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
    if (!editor || this.preview()) {
      this.focusBodyPending = true; // the editor is still being made (its local copy is being read): it takes the focus when it is there
      return;
    }
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

  /** A file used in a notebook that is not the person's own is stored in that notebook's space: say which notebook it is for. */
  private uploadNotebook(): string | null {
    const nb = this.meta()?.notebookId;
    return nb && !this.access.isOwn(this.tree.notebookById().get(nb)) ? nb : null;
  }

  async insertFiles(files: File[], pos?: number): Promise<void> {
    const editor = this.editor();
    if (!editor) return;
    for (const file of files) {
      try {
        const added = await this.media.add(file, this.uploadNotebook());
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
    if (!editor || this.readOnly()) return;
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
    void this.flushToServer().then(() => this.dialog.open(ExportDialog, { data: { scope: 'page', id: m.id, name: m.title || this.lang.t('page.untitled') }, width: '440px' }));
  }

  async trash(): Promise<void> {
    const m = this.meta();
    if (!m || !this.mayDelete()) return;
    await this.flushToServer();
    await this.tree.deletePage(m.id);
    await this.router.navigate(['/app']);
    this.notify.info('page.deleted', {}, { key: 'common.undo', run: () => void this.tree.restorePage(m.id) });
  }

  async restore(): Promise<void> {
    if (!this.mayDelete()) return;
    await this.tree.restorePage(this.id());
    this.editor()?.setEditable(this.mayEdit());
  }

  /** Earlier versions of the page, for whoever manages the notebook. */
  versions(): void {
    const m = this.meta();
    if (!m || !this.mayRestore()) return;
    void this.flushToServer().then(() => this.dialog.open(SnapshotsDialog, { data: { pageId: m.id }, width: '720px', maxWidth: '95vw' }));
  }

  /** Try the server again now (after the network came back). */
  reconnect(): void {
    this.session()?.retryNow();
  }
}

/** "example.com" is what people type; make it a real URL. */
function normaliseHref(v: string): string {
  return /^[a-z][a-z0-9+.-]*:|^[#/]/i.test(v) ? v : /^[^\s]+\.[^\s]+$/.test(v) ? `https://${v}` : v;
}
