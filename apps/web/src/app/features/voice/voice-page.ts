import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  Directive,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import type { Track } from 'livekit-client';
import type { ChannelDto } from '@os-planner/shared';
import { Permission, hasPermission, permissionsFromString } from '@os-planner/shared/lite';
import { toProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { ChatStore } from '../../data/chat-store';
import { Features } from '../../data/features';
import { VoiceService, type VoiceTile } from '../../data/voice-service';
import { VoiceStore } from '../../data/voice-store';
import { NotFoundPage } from '../shell/not-found';
import { VoiceControls } from './voice-bar';

/** Shows a media track (the camera or a shared screen) in the video element it sits on. */
@Directive({ selector: 'video[appTrack]' })
export class TrackAttach {
  readonly appTrack = input<Track | null>(null);
  private readonly el = inject<ElementRef<HTMLVideoElement>>(ElementRef);

  constructor() {
    effect((onCleanup) => {
      const track = this.appTrack();
      const el = this.el.nativeElement;
      if (!track) return;
      track.attach(el);
      onCleanup(() => track.detach(el));
    });
  }
}

/**
 * A voice channel: who is in it, and (once the person joined) the call itself: tiles with a speaking ring, camera pictures, a shared
 * screen at full size, a tile to pin, and for moderators a menu on each person.
 */
@Component({
  selector: 'app-voice-page',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    TranslocoPipe,
    TrackAttach,
    VoiceControls,
    NotFoundPage,
  ],
  template: `
    @if (!features.voice() || !channel() || channel()!.kind !== 'voice') {
      @if (features.known() && (!features.voice() || missing())) {
        <app-not-found />
      }
    } @else {
      @let ch = channel()!;
      <div class="page" data-voice-page>
        <header class="head">
          <mat-icon aria-hidden="true">volume_up</mat-icon>
          <h1>{{ ch.name }}</h1>
          <span class="count muted" data-voice-count>{{
            'voice.inChannel' | transloco: { n: shown().length }
          }}</span>
          <span class="grow"></span>
          @if (canManage()) {
            <a
              mat-icon-button
              [routerLink]="['/app/c', ch.id, 'settings']"
              [attr.aria-label]="'channel.settings' | transloco"
              ><mat-icon>settings</mat-icon></a
            >
          }
        </header>

        @if (here()) {
          @if (voice.blocked(); as b) {
            <div class="notice warn" role="alert" data-voice-blocked>
              <mat-icon>block</mat-icon>
              <span>{{ 'voice.blocked.' + b | transloco }}</span>
            </div>
          }
          @if (voice.audioBlocked()) {
            <div class="notice" role="status" data-voice-audio-blocked>
              <mat-icon>volume_off</mat-icon>
              <span>{{ 'voice.audioBlocked' | transloco }}</span>
              <button mat-stroked-button type="button" (click)="voice.startAudio()">
                {{ 'voice.enableSound' | transloco }}
              </button>
            </div>
          }
          @if (voice.modMuted()) {
            <div class="notice warn" role="status" data-voice-modmuted>
              <mat-icon>mic_off</mat-icon>
              <span>{{
                (voice.mutedBy() ? 'voice.mutedBy' : 'voice.mutedByModerator')
                  | transloco: { name: voice.mutedBy() }
              }}</span>
            </div>
          } @else if (!voice.canSpeak()) {
            <div class="notice" role="status" data-voice-listen-only>
              <mat-icon>hearing</mat-icon>
              <span>{{ 'voice.listenOnly' | transloco }}</span>
            </div>
          }

          <div class="stage" [class.has-focus]="!!focus()" data-voice-stage>
            @if (focus(); as f) {
              <div class="focus" data-voice-focus [attr.data-user]="f.tile.id">
                <ng-container
                  *ngTemplateOutlet="
                    tileView;
                    context: { $implicit: f.tile, big: true, screen: f.screen }
                  "
                />
              </div>
            }
            <div class="grid" [class.strip]="!!focus()">
              @for (t of voice.tiles(); track t.id) {
                <ng-container
                  *ngTemplateOutlet="tileView; context: { $implicit: t, big: false, screen: false }"
                />
              }
            </div>
          </div>
          <div class="controls"><app-voice-controls /></div>
        } @else {
          <div class="join">
            @if (!canConnect()) {
              <p class="muted" data-voice-no-permission>{{ 'voice.noPermission' | transloco }}</p>
            } @else if (ch.archived) {
              <p class="muted">{{ 'voice.archived' | transloco }}</p>
            } @else {
              <button
                mat-flat-button
                type="button"
                (click)="join()"
                data-voice-join
                [disabled]="voice.state() === 'connecting'"
              >
                <mat-icon>call</mat-icon
                >{{ (voice.active() ? 'voice.switchHere' : 'voice.join') | transloco }}
              </button>
              @if (ch.userLimit) {
                <span class="muted">{{ 'voice.limit' | transloco: { n: ch.userLimit } }}</span>
              }
            }
          </div>
          <ul class="people" data-voice-people>
            @for (p of stored(); track p.userId) {
              <li [attr.data-user]="p.userId">
                <span class="dot" [style.background]="p.color">{{
                  p.name.charAt(0).toUpperCase()
                }}</span>{{ p.name }}
                @if (p.mutedByModerator) {
                  <mat-icon class="state">mic_off</mat-icon>
                }
              </li>
            } @empty {
              <li class="muted">{{ 'voice.nobody' | transloco }}</li>
            }
          </ul>
        }
      </div>
    }

    <ng-template #tileView let-t let-big="big" let-screen="screen">
      <div
        class="tile"
        [class.speaking]="t.speaking"
        [class.big]="big"
        [class.pinned]="pinned() === t.id"
        data-voice-tile
        [attr.data-user]="t.id"
        [attr.data-speaking]="t.speaking"
        [attr.data-mic]="t.mic"
        [attr.data-camera]="t.camera"
        [attr.data-screen]="t.screen"
      >
        @if (screen && t.screenTrack) {
          <video
            [appTrack]="t.screenTrack"
            autoplay
            playsinline
            muted
            data-voice-video="screen"
          ></video>
        } @else if (t.cameraTrack && t.camera) {
          <video
            [appTrack]="t.cameraTrack"
            autoplay
            playsinline
            muted
            data-voice-video="camera"
          ></video>
        } @else {
          <span class="avatar" [style.background]="t.color">{{
            t.name.charAt(0).toUpperCase()
          }}</span>
        }
        <div class="label">
          <mat-icon class="mic" [class.off]="!t.mic">{{ t.mic ? 'mic' : 'mic_off' }}</mat-icon>
          <span class="n"
            >{{ t.name }}{{ t.local ? ' (' + ('voice.you' | transloco) + ')' : '' }}</span
          >
          @if (t.modMuted) {
            <span class="mod" data-voice-modbadge>{{ 'voice.moderatorMuted' | transloco }}</span>
          }
          @if (t.screen && !screen) {
            <mat-icon class="rec" [attr.title]="'voice.screenIsShared' | transloco"
              >screen_share</mat-icon
            >
          }
          @if (t.camera && !t.cameraTrack) {
            <mat-icon>videocam</mat-icon>
          }
        </div>
        <div class="acts">
          <button
            type="button"
            class="act"
            (click)="pin(t)"
            [attr.aria-label]="'voice.pin' | transloco"
            data-voice-pin
          >
            <mat-icon>{{ pinned() === t.id ? 'push_pin' : 'open_in_full' }}</mat-icon>
          </button>
          @if (!t.local && moderator()) {
            <button
              type="button"
              class="act"
              [matMenuTriggerFor]="mod"
              [matMenuTriggerData]="{ t: t }"
              [attr.aria-label]="'voice.moderate' | transloco"
              data-voice-moderate
            >
              <mat-icon>more_vert</mat-icon>
            </button>
          }
        </div>
      </div>
    </ng-template>

    <mat-menu #mod="matMenu">
      <ng-template matMenuContent let-t="t">
        @if (can.mute()) {
          @if (t.modMuted) {
            <button
              mat-menu-item
              type="button"
              (click)="act(t, 'unmute')"
              data-voice-action="unmute"
            >
              <mat-icon>mic</mat-icon>{{ 'voice.admin.unmute' | transloco }}
            </button>
          } @else {
            <button mat-menu-item type="button" (click)="act(t, 'mute')" data-voice-action="mute">
              <mat-icon>mic_off</mat-icon>{{ 'voice.admin.mute' | transloco }}
            </button>
          }
        }
        @if (can.move()) {
          @for (o of others(); track o.id) {
            <button
              mat-menu-item
              type="button"
              (click)="act(t, 'move', o.id)"
              data-voice-action="move"
              [attr.data-to]="o.name"
            >
              <mat-icon>drive_file_move</mat-icon
              >{{ 'voice.admin.moveTo' | transloco: { name: o.name } }}
            </button>
          }
        }
        @if (can.disconnect()) {
          <button
            mat-menu-item
            type="button"
            (click)="act(t, 'disconnect')"
            data-voice-action="disconnect"
          >
            <mat-icon>call_end</mat-icon>{{ 'voice.admin.disconnect' | transloco }}
          </button>
        }
      </ng-template>
    </mat-menu>
  `,
  styles: `
    :host {
      display: block;
    }
    .page {
      max-width: 1180px;
      margin: 0 auto;
      padding: 20px 20px 80px;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .head h1 {
      margin: 0;
      font-size: 22px;
    }
    .grow {
      flex: 1;
    }
    .join {
      display: flex;
      align-items: center;
      gap: 14px;
      margin: 14px 0;
    }
    .people {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .people li {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dot,
    .avatar {
      display: grid;
      place-items: center;
      color: #fff;
      font-weight: 700;
      border-radius: 50%;
    }
    .dot {
      width: 24px;
      height: 24px;
      font-size: 12px;
    }
    .state {
      font-size: 16px;
      width: 16px;
      height: 16px;
      color: var(--text-dim);
    }
    .notice {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      margin-bottom: 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface-3);
      font-size: 14px;
    }
    .notice.warn {
      border-color: color-mix(in srgb, var(--mat-sys-error) 45%, var(--border));
    }
    .stage {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .focus {
      height: min(56vh, 560px);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 10px;
    }
    .grid.strip {
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    }
    .tile {
      position: relative;
      display: grid;
      place-items: center;
      min-height: 150px;
      aspect-ratio: 16 / 9;
      border-radius: 12px;
      overflow: hidden;
      background: var(--surface-3);
      border: 2px solid transparent;
    }
    .tile.big {
      height: 100%;
      aspect-ratio: auto;
    }
    .tile.speaking {
      border-color: var(--accent);
    }
    .tile video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
    }
    .avatar {
      width: 64px;
      height: 64px;
      font-size: 28px;
    }
    .label {
      position: absolute;
      left: 8px;
      bottom: 8px;
      max-width: calc(100% - 16px);
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
      font-size: 13px;
    }
    .label .n {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .label mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .label .off {
      color: #ff8a80;
    }
    .label .rec {
      color: #ff8a80;
    }
    .mod {
      font-size: 11px;
      padding: 0 6px;
      border-radius: 6px;
      background: #b3261e;
    }
    .acts {
      position: absolute;
      top: 6px;
      right: 6px;
      display: none;
      gap: 4px;
    }
    .tile:hover .acts,
    .tile:focus-within .acts {
      display: flex;
    }
    .act {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 50%;
      cursor: pointer;
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
    }
    .act mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .controls {
      position: sticky;
      bottom: 12px;
      display: flex;
      justify-content: center;
      margin-top: 16px;
    }
    .controls app-voice-controls {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.2);
    }
  `,
})
export class VoicePage {
  readonly channelId = input.required<string>();

  protected readonly voice = inject(VoiceService);
  protected readonly features = inject(Features);
  private readonly chat = inject(ChatStore);
  private readonly store = inject(VoiceStore);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);

  protected readonly pinned = signal<string | null>(null);
  /**
   * The channel as the server sent it, for a link opened before this device knows the channel's team (a new member, a new device):
   * the chat store keeps a fetched channel only once its team is known, and nothing would load that team's channels from here.
   */
  private readonly fetched = signal<(ChannelDto & { teamId?: string }) | null>(null);
  protected readonly channel = computed(() => {
    const id = this.channelId();
    return this.chat.channelById().get(id) ?? (this.fetched()?.id === id ? this.fetched() : null);
  });
  protected readonly missing = signal(false);
  /** Is the person's call in this channel? */
  protected readonly here = computed(
    () => this.voice.channelId() === this.channelId() && this.voice.state() !== 'idle',
  );
  protected readonly stored = computed(() => this.store.participants(this.channelId()));
  protected readonly shown = computed(() => (this.here() ? this.voice.tiles() : this.stored()));

  private readonly held = computed(
    () => permissionsFromString(this.channel()?.permissions ?? '0') ?? 0n,
  );
  protected readonly canConnect = computed(() => hasPermission(this.held(), Permission.CONNECT));
  protected readonly canManage = computed(() =>
    hasPermission(this.held(), Permission.MANAGE_CHANNELS),
  );
  protected readonly can = {
    mute: computed(() => hasPermission(this.held(), Permission.MUTE_MEMBERS)),
    move: computed(() => hasPermission(this.held(), Permission.MOVE_MEMBERS)),
    disconnect: computed(
      () => (this.held() & (Permission.MOVE_MEMBERS | Permission.MANAGE_CHANNELS)) !== 0n,
    ),
  };
  protected readonly moderator = computed(
    () => this.can.mute() || this.can.move() || this.can.disconnect(),
  );

  /** The other voice channels of this team a person can be moved to. */
  protected readonly others = computed(() => {
    const c = this.channel();
    return c?.teamId
      ? this.chat
          .channelsOfTeam(c.teamId)
          .filter((o) => o.kind === 'voice' && o.id !== c.id && !o.archived)
      : [];
  });

  /** What is shown big: a shared screen, else the tile somebody pinned. */
  protected readonly focus = computed<{ tile: VoiceTile; screen: boolean } | null>(() => {
    const tiles = this.voice.tiles();
    const pin = tiles.find((t) => t.id === this.pinned());
    if (pin) return { tile: pin, screen: !!pin.screenTrack };
    const sharing = tiles.find((t) => t.screenTrack);
    return sharing ? { tile: sharing, screen: true } : null;
  });

  constructor() {
    // A link to a channel that was not loaded yet: ask once, and show "not found" only when the server says so.
    effect(() => {
      const id = this.channelId();
      if (this.chat.channelById().has(id)) return this.missing.set(false);
      void this.chat.fetch(id).then((c) => {
        this.fetched.set(c);
        this.missing.set(!c);
      });
    });
  }

  protected join(): void {
    void this.voice.join(this.channelId());
  }

  protected pin(t: VoiceTile): void {
    this.pinned.update((p) => (p === t.id ? null : t.id));
  }

  protected async act(
    t: VoiceTile,
    action: 'mute' | 'unmute' | 'move' | 'disconnect',
    toChannelId?: string,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(
          `/api/channels/${this.channelId()}/voice/participants/${t.id}/${action}`,
          toChannelId ? { toChannelId } : {},
        ),
      );
    } catch (e) {
      const p = toProblem(e);
      this.notify.error(
        p.status === 403
          ? 'voice.admin.denied'
          : p.code === 'channel_full'
            ? 'voice.channelFull'
            : p.status === 404
              ? 'voice.admin.gone'
              : 'errors.generic',
      );
    }
  }
}
