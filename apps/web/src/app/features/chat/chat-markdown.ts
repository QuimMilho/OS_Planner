import { Component, computed, inject, input, signal, effect, untracked } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import type { MentionsDto } from '@os-planner/shared';
import { parseChatMarkdown, type Block, type Inline, type MentionKind } from '@os-planner/shared/chat';
import { MentionDirectory } from '../../data/mention-directory';

/** One token of highlighted code: its text and the highlight.js class that colours it, if any. */
interface Token {
  text: string;
  cls: string | null;
}

let lowlight: Promise<{
  highlight(language: string, code: string): { children: unknown[] };
  registered(name: string): boolean;
}> | null = null;

/** The code split into coloured tokens; plain text when the language is unknown or the library cannot load. Loads on first use. */
async function highlight(code: string, lang: string | null): Promise<Token[] | null> {
  if (!lang) return null;
  try {
    lowlight ??= import('lowlight').then(
      ({ common, createLowlight }) => createLowlight(common) as never,
    );
    const ll = await lowlight;
    if (!ll.registered(lang)) return null;
    const out: Token[] = [];
    const walk = (nodes: unknown[], cls: string | null): void => {
      for (const n of nodes as {
        type: string;
        value?: string;
        properties?: { className?: string[] };
        children?: unknown[];
      }[]) {
        if (n.type === 'text') out.push({ text: n.value ?? '', cls });
        else if (n.type === 'element')
          walk(n.children ?? [], n.properties?.className?.join(' ') ?? cls);
      }
    };
    walk(ll.highlight(lang, code).children, null);
    return out;
  } catch {
    return null;
  }
}

/** The inline parts of a message: text, emphasis, code and links. Draws only what the parser produced, as text. */
@Component({
  selector: 'app-chat-inlines',
  template: `@for (n of nodes(); track $index) {
    @if (n.t === 'text') {
      <!-- a text node must hold exactly the text: any space around it would show in the message -->
      <ng-container>{{ n.v }}</ng-container>
    } @else if (n.t === 'br') {
      <br />
    } @else if (n.t === 'code') {
      <code>{{ n.v }}</code>
    } @else if (n.t === 'link') {
      <a [href]="n.href" target="_blank" rel="noopener noreferrer nofollow"
        ><app-chat-inlines [nodes]="n.c" [mentions]="mentions()"
      /></a>
    } @else if (n.t === 'strong') {
      <strong><app-chat-inlines [nodes]="n.c" [mentions]="mentions()" /></strong>
    } @else if (n.t === 'em') {
      <em><app-chat-inlines [nodes]="n.c" [mentions]="mentions()" /></em>
    } @else if (n.t === 'del') {
      <del><app-chat-inlines [nodes]="n.c" [mentions]="mentions()" /></del>
    } @else if (n.t === 'mention') {
      @if (accepted(n.kind, n.id)) {
        <span
          class="mention"
          [class.me]="mine(n.kind, n.id)"
          [style.--role]="color(n.kind, n.id)"
          data-mention
          [attr.data-kind]="n.kind"
          >{{ label(n.kind, n.id) }}</span
        >
      } @else {
        <ng-container>{{ label(n.kind, n.id) }}</ng-container>
      }
    }
  }`,
  styles: `
    :host {
      display: contents;
    }
    .mention {
      padding: 0 4px;
      border-radius: 4px;
      font-weight: 600;
      color: var(--role, var(--accent));
      background: color-mix(in srgb, var(--role, var(--accent)) 16%, transparent);
    }
    .mention.me {
      background: color-mix(in srgb, var(--role, var(--accent)) 34%, transparent);
    }
  `,
})
export class ChatInlines {
  readonly nodes = input.required<readonly Inline[]>();
  /** The mentions the server accepted for this message: a token that is not among them is drawn as plain text. */
  readonly mentions = input<MentionsDto | null>(null);
  private readonly directory = inject(MentionDirectory);
  private readonly i18n = inject(TranslocoService);

  protected accepted(kind: MentionKind, id: string | null): boolean {
    const m = this.mentions();
    if (!m) return false;
    return kind === 'everyone' ? m.everyone : kind === 'here' ? m.here : kind === 'user' ? m.users.includes(id!) : m.roles.includes(id!);
  }
  protected label(kind: MentionKind, id: string | null): string {
    return this.directory.label(kind, id, { user: this.i18n.translate('mentions.someone'), role: this.i18n.translate('mentions.aRole') });
  }
  /** It is about me: my name, a role I hold, or everybody. */
  protected mine(kind: MentionKind, id: string | null): boolean {
    return kind === 'everyone' || kind === 'here' || (kind === 'user' ? this.directory.isMe(id) : this.directory.inRole(id));
  }
  protected color(kind: MentionKind, id: string | null): string | null {
    return kind === 'role' ? (this.directory.role(id)?.color ?? null) : null;
  }
}

/** A fenced code block, coloured once the highlighter has loaded. */
@Component({
  selector: 'app-chat-code',
  template: `<pre
    [attr.data-lang]="lang()"
  ><code>@if (tokens(); as ts) { @for (t of ts; track $index) { @if (t.cls) {<span [class]="t.cls">{{ t.text }}</span>} @else {{{ t.text }}} } } @else {{{ code() }}}</code></pre>`,
  styles: `
    pre {
      margin: 4px 0;
      padding: 10px 12px;
      overflow: auto;
      border-radius: 8px;
      background: var(--surface-3);
      border: 1px solid var(--border);
      font-size: 13px;
      line-height: 1.45;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre;
    }
    .hljs-keyword,
    .hljs-built_in,
    .hljs-literal {
      color: var(--accent);
      font-weight: 600;
    }
    .hljs-string,
    .hljs-regexp {
      color: #2f9e44;
    }
    .hljs-number,
    .hljs-attr {
      color: #e8590c;
    }
    .hljs-comment {
      color: var(--text-dim);
      font-style: italic;
    }
    .hljs-title,
    .hljs-function {
      color: #1c7ed6;
    }
  `,
})
export class ChatCode {
  readonly code = input.required<string>();
  readonly lang = input<string | null>(null);
  protected readonly tokens = signal<Token[] | null>(null);

  constructor() {
    effect(() => {
      const code = this.code();
      const lang = this.lang();
      untracked(() => void highlight(code, lang).then((t) => this.tokens.set(t)));
    });
  }
}

/** The blocks of a message; it draws itself for quotes and list items. */
@Component({
  selector: 'app-chat-blocks',
  imports: [ChatInlines, ChatCode],
  template: `@for (b of blocks(); track $index) {
    @if (b.t === 'p') {
      <p><app-chat-inlines [nodes]="b.c" [mentions]="mentions()" /></p>
    } @else if (b.t === 'h') {
      @if (b.level === 1) {
        <h3 class="h1"><app-chat-inlines [nodes]="b.c" [mentions]="mentions()" /></h3>
      } @else if (b.level === 2) {
        <h4 class="h2"><app-chat-inlines [nodes]="b.c" [mentions]="mentions()" /></h4>
      } @else {
        <h5 class="h3"><app-chat-inlines [nodes]="b.c" [mentions]="mentions()" /></h5>
      }
    } @else if (b.t === 'quote') {
      <blockquote><app-chat-blocks [blocks]="b.c" [mentions]="mentions()" /></blockquote>
    } @else if (b.t === 'ul') {
      <ul>
        @for (item of b.items; track $index) {
          <li><app-chat-blocks [blocks]="item" [mentions]="mentions()" /></li>
        }
      </ul>
    } @else if (b.t === 'ol') {
      <ol [attr.start]="b.start">
        @for (item of b.items; track $index) {
          <li><app-chat-blocks [blocks]="item" [mentions]="mentions()" /></li>
        }
      </ol>
    } @else if (b.t === 'code') {
      <app-chat-code [code]="b.v" [lang]="b.lang" />
    } @else if (b.t === 'hr') {
      <hr />
    }
  }`,
  styles: `
    :host {
      display: block;
    }
    p {
      margin: 0;
      overflow-wrap: anywhere;
    }
    p + p,
    p + ul,
    p + ol,
    ul + p,
    ol + p {
      margin-top: 6px;
    }
    h3,
    h4,
    h5 {
      margin: 6px 0 2px;
    }
    blockquote {
      margin: 4px 0;
      padding: 0 0 0 10px;
      border-left: 3px solid var(--border);
      color: var(--text-dim);
    }
    ul,
    ol {
      margin: 4px 0;
      padding-left: 22px;
    }
    li > :host,
    li p {
      margin: 0;
    }
    hr {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 8px 0;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
      background: var(--surface-3);
      padding: 1px 5px;
      border-radius: 4px;
    }
    a {
      color: var(--accent);
    }
  `,
})
export class ChatBlocks {
  readonly blocks = input.required<readonly Block[]>();
  readonly mentions = input<MentionsDto | null>(null);
}

/** A chat message's Markdown, safely drawn (no HTML ever comes out of the text). */
@Component({
  selector: 'app-chat-markdown',
  imports: [ChatBlocks],
  template: `<app-chat-blocks [blocks]="blocks()" [mentions]="mentions()" />`,
  styles: `
    :host {
      display: block;
      line-height: 1.45;
    }
  `,
})
export class ChatMarkdown {
  readonly text = input.required<string>();
  /** The mentions of this message the server accepted. */
  readonly mentions = input<MentionsDto | null>(null);
  protected readonly blocks = computed(() => parseChatMarkdown(this.text()));
}
