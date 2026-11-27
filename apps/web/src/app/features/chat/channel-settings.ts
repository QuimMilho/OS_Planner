import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission, hasPermission, permissionsFromString } from '@os-planner/shared/lite';
import { type RoleDto } from '@os-planner/shared';
import { CHAT_LIMITS } from '@os-planner/shared/chat';
import { VOICE_LIMITS, VOICE_QUALITY, type VoiceQuality } from '@os-planner/shared/lite';
import { toProblem, type ApiProblem } from '../../core/auth-store';
import { AppUpdates } from '../../core/app-updates';
import { Notify } from '../../core/notify';
import { chatErrorKey } from '../../data/chat-actions';
import { ChatStore } from '../../data/chat-store';
import { RolesStore } from '../../data/roles-store';
import { TeamStore } from '../../data/team-store';
import { Dialogs } from '../../shared/dialogs';
import { NotFoundPage } from '../shell/not-found';
import { OverwriteEditor } from '../team/overwrite-editor';
import { roleErrorKey } from '../team/roles-editor';

const SLOWMODE_CHOICES = [0, 5, 10, 30, 60, 300, 900, 3600, 21600];

/** A channel's name, topic, slowmode and archive state, who may see and use it, and deleting it. */
@Component({
  selector: 'app-channel-settings',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    TranslocoPipe,
    NotFoundPage,
    OverwriteEditor,
  ],
  template: `
    @switch (view()) {
      @case ('missing') {
        <app-not-found />
      }
      @case ('ready') {
        @if (channel(); as ch) {
          <div class="page" data-channel-settings>
            <a class="back" [routerLink]="[ch.kind === 'voice' ? '/app/v' : '/app/c', ch.id]"
              ><mat-icon>arrow_back</mat-icon>{{ ch.kind === 'voice' ? '' : '#' }}{{ ch.name }}</a
            >
            <h1>{{ 'channel.settings' | transloco }}</h1>

            @if (canManage()) {
              <section class="block">
                <h2>{{ 'channel.details' | transloco }}</h2>
                <form (ngSubmit)="save()" class="form">
                  <label
                    >{{ 'channel.name' | transloco }}
                    <input
                      name="name"
                      [(ngModel)]="name"
                      (ngModelChange)="syncDraft()"
                      maxlength="80"
                      required
                      data-field="name"
                    />
                  </label>
                  @if (ch.kind === 'text') {
                    <label
                      >{{ 'channel.topic' | transloco }}
                      <input
                        name="topic"
                        [(ngModel)]="topic"
                        (ngModelChange)="syncDraft()"
                        [attr.maxlength]="topicMax"
                        data-field="topic"
                      />
                    </label>
                    <label
                      >{{ 'channel.slowmode' | transloco }}
                      <select
                        name="slowmode"
                        [(ngModel)]="slowmode"
                        (ngModelChange)="syncDraft()"
                        data-field="slowmode"
                      >
                        @for (s of slowmodes; track s) {
                          <option [ngValue]="s">
                            {{ s === 0 ? ('channel.slowmodeOff' | transloco) : label(s) }}
                          </option>
                        }
                      </select>
                    </label>
                    <p class="muted hint">{{ 'channel.slowmodeHint' | transloco }}</p>
                    <label class="check">
                      <input type="checkbox" name="redact" [(ngModel)]="redact" (ngModelChange)="syncDraft()" data-field="redact-previews" />
                      {{ 'channel.redactPreviews' | transloco }}
                    </label>
                    <p class="muted hint">{{ 'channel.redactPreviewsHint' | transloco }}</p>
                  }
                  @if (ch.kind === 'voice') {
                    <label
                      >{{ 'voice.userLimit' | transloco }}
                      <input
                        type="number"
                        name="userLimit"
                        min="1"
                        [max]="userLimitMax"
                        [(ngModel)]="userLimit"
                        (ngModelChange)="syncDraft()"
                        [placeholder]="'voice.userLimitDefault' | transloco"
                        data-field="user-limit"
                      />
                    </label>
                    <p class="muted hint">{{ 'voice.userLimitHint' | transloco }}</p>
                    <label
                      >{{ 'voice.audioQuality' | transloco }}
                      <select
                        name="quality"
                        [(ngModel)]="quality"
                        (ngModelChange)="syncDraft()"
                        data-field="quality"
                      >
                        @for (q of qualities; track q) {
                          <option [ngValue]="q">{{ 'voice.q.' + q | transloco }}</option>
                        }
                      </select>
                    </label>
                  }
                  <div class="actions">
                    <button
                      mat-flat-button
                      type="submit"
                      [disabled]="!dirty()"
                      data-action="save-channel"
                    >
                      {{ 'common.save' | transloco }}
                    </button>
                    @if (ch.kind !== 'category') {
                      <button
                        mat-stroked-button
                        type="button"
                        (click)="toggleArchive()"
                        data-action="archive-channel"
                      >
                        <mat-icon>{{ ch.archived ? 'unarchive' : 'archive' }}</mat-icon>{{
                          (ch.archived ? 'channel.unarchive' : 'channel.archive') | transloco
                        }}
                      </button>
                    }
                  </div>
                </form>
              </section>
            }

            @if (canOverwrite()) {
              <section class="block">
                <h2>{{ 'channel.permissions' | transloco }}</h2>
                <p class="muted">{{ 'channel.permissionsHint' | transloco }}</p>
                <app-overwrite-editor
                  kind="channel"
                  [projectId]="ch.id"
                  [teamId]="teamId()"
                  [held]="ch.permissions"
                  [roles]="roles()"
                />
              </section>
            }

            @if (canManage()) {
              <section class="block danger">
                <h2>{{ 'channel.deleteTitle' | transloco }}</h2>
                <p class="muted">{{ 'channel.deleteWarning' | transloco }}</p>
                <button
                  mat-flat-button
                  type="button"
                  class="del"
                  (click)="remove()"
                  data-action="delete-channel"
                >
                  <mat-icon>delete</mat-icon>{{ 'common.delete' | transloco }}
                </button>
              </section>
            }
          </div>
        }
      }
    }
  `,
  styles: `
    .page {
      max-width: 1040px;
      margin: 0 auto;
      padding: 24px 20px 64px;
    }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--text-dim);
      text-decoration: none;
      font-size: 14px;
    }
    h1 {
      margin: 8px 0 16px;
      font-size: 26px;
    }
    .block {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px 20px;
      margin-bottom: 18px;
    }
    .block h2 {
      margin: 0 0 10px;
      font-size: 18px;
    }
    .form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 520px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
      color: var(--text-dim);
    }
    input,
    select {
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
    }
    .hint {
      margin: -6px 0 0;
      font-size: 12.5px;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .danger {
      border-color: color-mix(in srgb, var(--mat-sys-error) 40%, var(--border));
    }
    .del {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class ChannelSettings {
  readonly channelId = input.required<string>();

  private readonly chat = inject(ChatStore);
  private readonly teams = inject(TeamStore);
  private readonly rolesStore = inject(RolesStore);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);
  private readonly router = inject(Router);

  protected readonly view = signal<'loading' | 'ready' | 'missing'>('loading');
  protected readonly channel = computed(
    () => this.chat.channelById().get(this.channelId()) ?? null,
  );
  protected readonly roles = signal<RoleDto[]>([]);
  protected readonly slowmodes = SLOWMODE_CHOICES;
  protected readonly topicMax = CHAT_LIMITS.topicMax;
  protected readonly userLimitMax = VOICE_LIMITS.userLimitMax;
  protected readonly qualities = VOICE_QUALITY;
  protected userLimit: number | null = null;
  protected quality: VoiceQuality = 'normal';
  protected name = '';
  protected topic = '';
  protected slowmode = 0;
  protected redact = false;

  private readonly held = computed(
    () => permissionsFromString(this.channel()?.permissions ?? '0') ?? 0n,
  );
  protected readonly canManage = computed(() =>
    hasPermission(this.held(), Permission.MANAGE_CHANNELS),
  );
  protected readonly canOverwrite = computed(
    () => this.canManage() || hasPermission(this.held(), Permission.MANAGE_ROLES),
  );
  protected readonly teamId = computed(() => this.channel()?.teamId ?? '');
  protected readonly dirty = computed(() => {
    const c = this.channel();
    return (
      !!c &&
      (this.draft().name !== c.name ||
        this.draft().topic !== c.topic ||
        this.draft().slowmode !== c.slowmodeSeconds ||
        this.draft().redact !== c.redactPreviews ||
        (c.kind === 'voice' &&
          (this.draft().userLimit !== c.userLimit || this.draft().quality !== (c.quality ?? 'normal'))))
    );
  });
  private readonly draft = signal<{ name: string; topic: string; slowmode: number; redact: boolean; userLimit: number | null; quality: VoiceQuality }>({
    name: '',
    topic: '',
    slowmode: 0,
    redact: false,
    userLimit: null,
    quality: 'normal',
  });

  constructor() {
    inject(AppUpdates).holdWhile(this.dirty); // an update's reload would throw the unsaved changes away
    effect(() => {
      const id = this.channelId();
      untracked(() => void this.verify(id));
    });
    effect(() => {
      const c = this.channel();
      if (!c) return;
      untracked(() => {
        this.name = c.name;
        this.topic = c.topic;
        this.slowmode = c.slowmodeSeconds;
        this.redact = c.redactPreviews;
        this.userLimit = c.userLimit;
        this.quality = c.quality ?? 'normal';
        this.draft.set({ name: c.name, topic: c.topic, slowmode: c.slowmodeSeconds, redact: c.redactPreviews, userLimit: c.userLimit, quality: c.quality ?? 'normal' });
        void this.loadRoles(c.teamId, c.spaceId);
      });
    });
  }

  private async verify(id: string): Promise<void> {
    this.view.set(this.channel() ? 'ready' : 'loading');
    try {
      const found = this.channel() ?? (await this.chat.fetch(id));
      this.view.set(found ? 'ready' : 'missing');
    } catch {
      this.view.set(this.channel() ? 'ready' : 'loading');
    }
  }

  private async loadRoles(teamId: string, spaceId: string): Promise<void> {
    try {
      const project = this.teams.projectBySpace().get(spaceId);
      const [team, inProject] = await Promise.all([
        this.rolesStore.roles({ kind: 'team', id: teamId }),
        project ? this.rolesStore.roles({ kind: 'project', id: project.id }) : Promise.resolve([]),
      ]);
      this.roles.set([...team, ...inProject]);
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    }
  }

  protected label(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${seconds / 60} min`;
    return `${seconds / 3600} h`;
  }

  /** Called by the form on every key: the draft the "save" button compares with. */
  protected syncDraft(): void {
    const limit = Number(this.userLimit);
    this.draft.set({
      name: this.name.trim(),
      topic: this.topic.trim(),
      slowmode: this.slowmode,
      redact: this.redact,
      userLimit: this.userLimit === null || String(this.userLimit) === '' || !Number.isFinite(limit) ? null : Math.max(1, Math.min(VOICE_LIMITS.userLimitMax, Math.round(limit))),
      quality: this.quality,
    });
  }

  protected async save(): Promise<void> {
    const c = this.channel();
    if (!c) return;
    this.syncDraft();
    const d = this.draft();
    try {
      await this.chat.update(c, {
        name: d.name,
        ...(c.kind === 'text' ? { topic: d.topic, slowmodeSeconds: d.slowmode, redactPreviews: d.redact } : {}),
        ...(c.kind === 'voice' ? { userLimit: d.userLimit, quality: d.quality } : {}),
      });
      this.notify.info('settings.saved');
    } catch (e) {
      const p = toProblem(e);
      this.notify.error(chatErrorKey(p.code, p.status));
    }
  }

  protected async toggleArchive(): Promise<void> {
    const c = this.channel();
    if (!c) return;
    try {
      await this.chat.update(c, { archived: !c.archived });
    } catch (e) {
      const p = toProblem(e);
      this.notify.error(chatErrorKey(p.code, p.status));
    }
  }

  protected async remove(): Promise<void> {
    const c = this.channel();
    if (!c) return;
    const ok = await this.dialogs.confirm({
      titleKey: 'channel.deleteTitle',
      messageKey: 'channel.deleteConfirm',
      params: { name: c.name },
      confirmKey: 'common.delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.chat.remove(c);
      await this.router.navigate(['/app/t', c.teamId]);
    } catch (e) {
      const p = toProblem(e);
      this.notify.error(chatErrorKey(p.code, p.status));
    }
  }
}
