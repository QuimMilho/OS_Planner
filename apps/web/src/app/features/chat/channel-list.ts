import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission, positionBetween } from '@os-planner/shared/lite';
import { toProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { chatErrorKey } from '../../data/chat-actions';
import { Features } from '../../data/features';
import { VoiceService } from '../../data/voice-service';
import { VoiceStore } from '../../data/voice-store';
import { ChatStore } from '../../data/chat-store';
import type { ChannelRow } from '../../data/db';
import { TeamStore } from '../../data/team-store';
import { Dialogs } from '../../shared/dialogs';

/** What a list of channels carries for drag and drop: where it is and what it holds. */
interface DropData {
  group: Group;
  parentId: string | null;
  items: ChannelRow[];
}

interface Group {
  /** The space the channels are in. */
  spaceId: string;
  /** Shown for a project's channels; null for the team's own. */
  title: string | null;
  projectId: string | null;
  canManage: boolean;
  /** Channels that sit in no category, then the categories with theirs. */
  loose: ChannelRow[];
  looseDrop: DropData;
  categories: { category: ChannelRow; channels: ChannelRow[]; drop: DropData }[];
}

const byPosition = (a: ChannelRow, b: ChannelRow): number =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;

/**
 * The channels of a team in its sidebar: the team's own, then each project's under its name, with categories that fold,
 * a bold name and a count for what is unread, and (for people who manage channels) "new channel" and drag and drop.
 */
@Component({
  selector: 'app-channel-list',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    MatIconModule,
    MatMenuModule,
    TranslocoPipe,
    CdkDropListGroup,
    CdkDropList,
    CdkDrag,
  ],
  template: `
    <div cdkDropListGroup data-channel-list>
      @for (g of groups(); track g.spaceId) {
        @if (g.title) {
          <h4 class="proj" [attr.data-channel-group]="g.title">
            <mat-icon>folder</mat-icon>{{ g.title }}
          </h4>
        }
        <div class="head" [class.sub]="!!g.title">
          <span>{{ 'channel.title' | transloco }}</span>
          @if (g.canManage) {
            <button
              type="button"
              class="add"
              [matMenuTriggerFor]="menu"
              [attr.aria-label]="'channel.create' | transloco"
              data-action="new-channel-menu"
            >
              <mat-icon>add</mat-icon>
            </button>
            <mat-menu #menu="matMenu">
              <button
                mat-menu-item
                type="button"
                (click)="create(g, null, 'text')"
                data-action="new-channel"
              >
                <mat-icon>tag</mat-icon>{{ 'channel.newChannel' | transloco }}
              </button>
              @if (features.voice()) {
                <button
                  mat-menu-item
                  type="button"
                  (click)="create(g, null, 'voice')"
                  data-action="new-voice-channel"
                >
                  <mat-icon>volume_up</mat-icon>{{ 'channel.newVoice' | transloco }}
                </button>
              }
              <button
                mat-menu-item
                type="button"
                (click)="create(g, null, 'category')"
                data-action="new-category"
              >
                <mat-icon>create_new_folder</mat-icon>{{ 'channel.newCategory' | transloco }}
              </button>
            </mat-menu>
          }
        </div>

        <div
          class="list"
          cdkDropList
          [cdkDropListData]="g.looseDrop"
          (cdkDropListDropped)="dropped($event)"
          [cdkDropListDisabled]="!g.canManage"
        >
          @for (c of g.loose; track c.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: c, g: g }" />
          }
        </div>
        @for (cat of g.categories; track cat.category.id) {
          <div class="cat" [attr.data-category]="cat.category.name">
            <button
              type="button"
              class="cat-head"
              (click)="toggle(cat.category.id)"
              [attr.aria-expanded]="!closed().has(cat.category.id)"
            >
              <mat-icon>{{
                closed().has(cat.category.id) ? 'chevron_right' : 'expand_more'
              }}</mat-icon>
              <span>{{ cat.category.name }}</span>
            </button>
            @if (g.canManage) {
              <button
                type="button"
                class="add"
                (click)="create(g, cat.category.id, 'text')"
                [attr.aria-label]="'channel.newChannel' | transloco"
              >
                <mat-icon>add</mat-icon>
              </button>
            }
          </div>
          @if (!closed().has(cat.category.id)) {
            <div
              class="list"
              cdkDropList
              [cdkDropListData]="cat.drop"
              (cdkDropListDropped)="dropped($event)"
              [cdkDropListDisabled]="!g.canManage"
            >
              @for (c of cat.channels; track c.id) {
                <ng-container *ngTemplateOutlet="row; context: { $implicit: c, g: g }" />
              }
            </div>
          }
        }
        @if (!g.loose.length && !g.categories.length) {
          <p class="muted none">
            {{ (g.canManage ? 'channel.noneManage' : 'channel.none') | transloco }}
          </p>
        }
      }
    </div>

    <ng-template #row let-c let-g="g">
      @if (c.kind === 'voice') {
        @if (features.voice()) {
          <div
            class="row voice"
            [class.active]="c.id === voice.channelId()"
            [attr.data-channel-row]="c.name"
            data-voice-row
          >
            <a
              class="name"
              [routerLink]="['/app/v', c.id]"
              (click)="joinVoice(c)"
              [attr.aria-label]="c.name"
            >
              <mat-icon aria-hidden="true">{{ c.archived ? 'inventory_2' : 'volume_up' }}</mat-icon>
              <span class="label">{{ c.name }}</span>
            </a>
            @if (g.canManage) {
              <a
                class="gear"
                [routerLink]="['/app/c', c.id, 'settings']"
                [attr.aria-label]="'channel.settings' | transloco"
                ><mat-icon>settings</mat-icon></a
              >
            }
          </div>
          @for (p of people(c.id); track p.userId) {
            <div class="who" [class.speaking]="p.speaking" data-voice-participant [attr.data-user]="p.userId">
              <span class="dot" [style.background]="p.color">{{ p.name.charAt(0).toUpperCase() }}</span>
              <span class="label">{{ p.name }}</span>
              @if (p.muted) {
                <mat-icon class="state" aria-hidden="true">mic_off</mat-icon>
              }
            </div>
          }
        }
      } @else {
      <div
        class="row"
        cdkDrag
        [cdkDragData]="c"
        [cdkDragDisabled]="!g.canManage"
        [class.active]="c.id === chat.openChannel()"
        [class.unread]="chat.unreadOf(c.id) > 0"
        [attr.data-channel-row]="c.name"
      >
        <a class="name" [routerLink]="['/app/c', c.id]" [attr.aria-label]="c.name">
          <mat-icon aria-hidden="true">{{ c.archived ? 'inventory_2' : 'tag' }}</mat-icon>
          <span class="label">{{ c.name }}</span>
        </a>
        @if (chat.mentionsOf(c.id) > 0) {
          <span class="badge mention" data-mention-badge>{{
            chat.mentionsOf(c.id) > 99 ? '99+' : chat.mentionsOf(c.id)
          }}</span>
        } @else if (chat.unreadOf(c.id) > 0) {
          <span class="badge" data-unread-badge>{{
            chat.unreadOf(c.id) > 99 ? '99+' : chat.unreadOf(c.id)
          }}</span>
        }
        @if (g.canManage) {
          <a
            class="gear"
            [routerLink]="['/app/c', c.id, 'settings']"
            [attr.aria-label]="'channel.settings' | transloco"
            ><mat-icon>settings</mat-icon></a
          >
        }
      </div>
      }
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      display: flex;
      align-items: center;
      margin: 14px 16px 4px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-dim);
    }
    .head.sub {
      margin-top: 2px;
    }
    .head span {
      flex: 1;
    }
    .proj {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 12px 16px 0;
      font-size: 13px;
      font-weight: 600;
    }
    .proj mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      color: var(--text-dim);
    }
    .add {
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--text-dim);
      display: grid;
      place-items: center;
      padding: 2px;
      border-radius: 6px;
    }
    .add:hover {
      background: var(--surface-3);
      color: var(--text);
    }
    .add mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .list {
      min-height: 4px;
    }
    .cat {
      display: flex;
      align-items: center;
      margin: 6px 12px 0 8px;
    }
    .cat-head {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 2px;
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--text-dim);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      text-align: left;
      padding: 2px 0;
    }
    .cat-head mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin: 0 6px;
      padding: 0 6px 0 12px;
      min-height: 32px;
      border-radius: 8px;
      font-size: 14px;
    }
    .row:hover,
    .row.active {
      background: var(--surface-3);
    }
    .row.active {
      font-weight: 600;
    }
    .row.unread .label {
      font-weight: 700;
      color: var(--text);
    }
    .name {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text-dim);
      text-decoration: none;
    }
    .row.unread .name,
    .row.active .name {
      color: var(--text);
    }
    .name mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      flex: none;
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge.mention {
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
    }
    .badge {
      flex: none;
      min-width: 18px;
      padding: 0 6px;
      border-radius: 9px;
      background: var(--accent);
      color: var(--mat-sys-on-primary);
      font-size: 11px;
      font-weight: 700;
      text-align: center;
      line-height: 18px;
    }
    .who {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 6px;
      padding: 2px 6px 2px 34px;
      min-height: 26px;
      font-size: 13px;
      color: var(--text-dim);
    }
    .who .dot {
      flex: none;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      box-shadow: 0 0 0 2px transparent;
    }
    .who.speaking .dot {
      box-shadow: 0 0 0 2px var(--accent);
    }
    .who .state {
      font-size: 14px;
      width: 14px;
      height: 14px;
      margin-left: auto;
    }
    .gear {
      display: none;
      color: var(--text-dim);
    }
    .row:hover .gear {
      display: grid;
      place-items: center;
    }
    .gear mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .none {
      margin: 4px 16px;
      font-size: 13px;
    }
    .cdk-drag-preview {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      background: var(--surface);
      border-radius: 8px;
    }
    .cdk-drag-placeholder {
      opacity: 0.35;
    }
  `,
})
export class ChannelList {
  readonly teamId = input.required<string>();

  protected readonly chat = inject(ChatStore);
  protected readonly features = inject(Features);
  protected readonly voice = inject(VoiceService);
  private readonly voiceStore = inject(VoiceStore);
  private readonly teams = inject(TeamStore);
  private readonly dialogs = inject(Dialogs);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);
  protected readonly closed = signal<ReadonlySet<string>>(new Set());

  protected readonly groups = computed<Group[]>(() => {
    const teamId = this.teamId();
    const team = this.teams.teamById().get(teamId);
    if (!team) return [];
    const rows = this.chat.channelsOfTeam(teamId);
    const spaces: { spaceId: string; title: string | null; projectId: string | null }[] = [
      { spaceId: team.spaceId, title: null, projectId: null },
    ];
    for (const p of this.teams.projects().filter((p) => p.teamId === teamId))
      spaces.push({ spaceId: p.spaceId, title: p.name, projectId: p.id });

    const out: Group[] = [];
    for (const s of spaces) {
      const mine = rows.filter((c) => c.spaceId === s.spaceId);
      const canManage = this.teams.can(
        teamId,
        Permission.MANAGE_CHANNELS,
        s.projectId ?? undefined,
      );
      // a project with nothing to show and nothing the person can add is left out
      if (s.projectId && !mine.length && !canManage) continue;
      const categories = mine.filter((c) => c.kind === 'category').sort(byPosition);
      const loose = mine.filter((c) => c.kind !== 'category' && !c.parentId).sort(byPosition);
      const group = { ...s, canManage, loose, categories: [] } as unknown as Group;
      group.looseDrop = { group, parentId: null, items: loose };
      group.categories = categories.map((category) => {
        const channels = mine
          .filter((c) => c.parentId === category.id && c.kind !== 'category')
          .sort(byPosition);
        return { category, channels, drop: { group, parentId: category.id, items: channels } };
      });
      out.push(group);
    }
    return out;
  });

  /** Who is in a voice channel: what the call shows for the one this person is in (who is speaking), else the server's list. */
  protected people(channelId: string): { userId: string; name: string; color: string; speaking: boolean; muted: boolean }[] {
    if (this.voice.channelId() === channelId && this.voice.tiles().length)
      return this.voice.tiles().map((t) => ({ userId: t.id, name: t.name, color: t.color, speaking: t.speaking, muted: !t.mic }));
    return this.voiceStore.participants(channelId).map((p) => ({ userId: p.userId, name: p.name, color: p.color, speaking: false, muted: p.mutedByModerator }));
  }

  /** Clicking a voice channel in the list joins it (the voice page opens next to it). */
  protected joinVoice(c: ChannelRow): void {
    if (c.archived) return;
    void this.voice.join(c.id);
  }

  protected toggle(id: string): void {
    this.closed.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected async create(
    g: Group,
    parentId: string | null,
    kind: 'text' | 'category' | 'voice',
  ): Promise<void> {
    const answer = await this.dialogs.prompt({
      titleKey: kind === 'category' ? 'channel.newCategory' : kind === 'voice' ? 'channel.newVoice' : 'channel.newChannel',
      labelKey: 'channel.name',
      placeholder: kind === 'category' ? '' : kind === 'voice' ? 'Lounge' : 'general',
      confirmKey: 'channel.create',
      validate: (v) => (v.trim() ? null : 'channel.nameRequired'),
    });
    if (answer?.action !== 'ok') return;
    try {
      const created = await this.chat.create(g.spaceId, this.teamId(), {
        name: answer.value.trim(),
        kind,
        ...(parentId ? { parentId } : {}),
      });
      if (kind === 'text') void this.router.navigate(['/app/c', created.id]);
      if (kind === 'voice') void this.router.navigate(['/app/v', created.id]);
    } catch (e) {
      const p = toProblem(e);
      this.notify.error(chatErrorKey(p.code, p.status));
    }
  }

  /** Dropping a channel somewhere: it takes the category of the list it landed in and a position between its new neighbours. */
  protected async dropped(event: CdkDragDrop<DropData>): Promise<void> {
    const target = event.container.data;
    const moved = event.item.data as ChannelRow | undefined;
    const channel = moved ?? event.previousContainer.data.items[event.previousIndex];
    if (!channel || target.group.spaceId !== channel.spaceId) return;
    const others = target.items.filter((c) => c.id !== channel.id);
    const index = Math.min(event.currentIndex, others.length);
    const position = positionBetween(
      others[index - 1]?.position ?? null,
      others[index]?.position ?? null,
    );
    try {
      await this.chat.reorder(channel.spaceId, this.teamId(), {
        items: [{ id: channel.id, parentId: target.parentId, position }],
      });
    } catch (e) {
      const p = toProblem(e);
      this.notify.error(chatErrorKey(p.code, p.status));
    }
  }
}
