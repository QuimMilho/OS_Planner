import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoPipe } from '@jsverse/transloco';
import { VoiceService } from '../../data/voice-service';

/** The call's buttons: microphone, headphones, camera, screen, leave. What is on is shown, and so is whatever the person may not do. */
@Component({
  selector: 'app-voice-controls',
  imports: [MatIconModule, MatTooltipModule, TranslocoPipe],
  template: `
    <button
      type="button"
      class="ctl"
      [class.off]="voice.muted() || voice.modMuted()"
      [disabled]="!voice.canSpeak() || voice.modMuted()"
      (click)="voice.toggleMute()"
      [attr.aria-pressed]="!voice.muted()"
      [attr.aria-label]="(voice.muted() ? 'voice.unmute' : 'voice.mute') | transloco"
      [matTooltip]="
        (voice.modMuted()
          ? 'voice.mutedByModerator'
          : voice.muted()
            ? 'voice.unmute'
            : 'voice.mute'
        ) | transloco
      "
      data-voice-mute
      [attr.data-muted]="voice.muted()"
    >
      <mat-icon>{{ voice.muted() || voice.modMuted() ? 'mic_off' : 'mic' }}</mat-icon>
    </button>
    <button
      type="button"
      class="ctl"
      [class.off]="voice.deafened()"
      (click)="voice.toggleDeafen()"
      [attr.aria-pressed]="voice.deafened()"
      [attr.aria-label]="(voice.deafened() ? 'voice.undeafen' : 'voice.deafen') | transloco"
      [matTooltip]="(voice.deafened() ? 'voice.undeafen' : 'voice.deafen') | transloco"
      data-voice-deafen
    >
      <mat-icon>{{ voice.deafened() ? 'headset_off' : 'headset' }}</mat-icon>
    </button>
    <button
      type="button"
      class="ctl"
      [class.live]="voice.cameraOn()"
      [disabled]="!voice.canVideo()"
      (click)="voice.toggleCamera()"
      [attr.aria-pressed]="voice.cameraOn()"
      [attr.aria-label]="(voice.cameraOn() ? 'voice.cameraOff' : 'voice.camera') | transloco"
      [matTooltip]="(voice.cameraOn() ? 'voice.cameraOff' : 'voice.camera') | transloco"
      data-voice-camera
    >
      <mat-icon>{{ voice.cameraOn() ? 'videocam' : 'videocam_off' }}</mat-icon>
    </button>
    <button
      type="button"
      class="ctl"
      [class.live]="voice.sharing()"
      [disabled]="!voice.canShare()"
      (click)="voice.toggleShare()"
      [attr.aria-pressed]="voice.sharing()"
      [attr.aria-label]="(voice.sharing() ? 'voice.shareStop' : 'voice.share') | transloco"
      [matTooltip]="(voice.sharing() ? 'voice.shareStop' : 'voice.share') | transloco"
      data-voice-share
    >
      <mat-icon>{{ voice.sharing() ? 'stop_screen_share' : 'screen_share' }}</mat-icon>
    </button>
    <button
      type="button"
      class="ctl leave"
      (click)="voice.leave()"
      [attr.aria-label]="'voice.leave' | transloco"
      [matTooltip]="'voice.leave' | transloco"
      data-voice-leave
    >
      <mat-icon>call_end</mat-icon>
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
      gap: 6px;
    }
    .ctl {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border: 0;
      border-radius: 50%;
      cursor: pointer;
      background: var(--surface-3);
      color: var(--text);
    }
    .ctl:hover:not(:disabled) {
      filter: brightness(0.95);
    }
    .ctl:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .ctl.off {
      background: color-mix(in srgb, var(--mat-sys-error) 22%, var(--surface-3));
      color: var(--mat-sys-error);
    }
    .ctl.live {
      background: var(--accent);
      color: var(--mat-sys-on-primary);
    }
    .ctl.leave {
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
    }
    .ctl mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }
  `,
})
export class VoiceControls {
  protected readonly voice = inject(VoiceService);
}

/**
 * The call in the sidebar, and a floating strip when the sidebar is hidden: the channel, how the connection is, the controls, and
 * what is switched on (a camera or a shared screen is always shown here, so nobody is on air without knowing).
 */
@Component({
  selector: 'app-voice-bar',
  imports: [RouterLink, MatIconModule, TranslocoPipe, VoiceControls],
  template: `
    @if (voice.active() && voice.channel(); as ch) {
      <div
        class="bar"
        [class.floating]="floating()"
        data-voice-bar
        [attr.data-state]="voice.state()"
      >
        <div class="top">
          <span
            class="q"
            [class]="'q ' + voice.quality()"
            [attr.title]="'voice.quality.' + voice.quality() | transloco"
            data-voice-quality
            ><mat-icon>signal_cellular_alt</mat-icon></span
          >
          <a class="name" [routerLink]="['/app/v', ch.id]" data-voice-bar-channel>
            <strong>{{ state() | transloco }}</strong>
            <span class="muted">{{ ch.name }}</span>
          </a>
          <span class="on" role="status" data-voice-live>
            @if (!voice.muted() && !voice.modMuted()) {
              <mat-icon [attr.title]="'voice.micOn' | transloco">mic</mat-icon>
            }
            @if (voice.cameraOn()) {
              <mat-icon class="rec" [attr.title]="'voice.cameraIsOn' | transloco"
                >videocam</mat-icon
              >
            }
            @if (voice.sharing()) {
              <mat-icon class="rec" [attr.title]="'voice.screenIsShared' | transloco"
                >screen_share</mat-icon
              >
            }
          </span>
        </div>
        <app-voice-controls />
      </div>
    }
  `,
  styles: `
    .bar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 8px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface-2, var(--surface));
    }
    .bar.floating {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 20;
      margin: 0;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
      background: var(--surface);
    }
    .top {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .name {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      text-decoration: none;
      color: var(--text);
      font-size: 13px;
    }
    .name .muted {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .q mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .q.excellent mat-icon,
    .q.good mat-icon {
      color: #2e9e5b;
    }
    .q.poor mat-icon {
      color: #d49a1a;
    }
    .q.lost mat-icon {
      color: var(--mat-sys-error);
    }
    .q.unknown mat-icon {
      color: var(--text-dim);
    }
    .on {
      display: inline-flex;
      gap: 2px;
      color: var(--text-dim);
    }
    .on mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .on .rec {
      color: var(--mat-sys-error);
    }
  `,
})
export class VoiceBar {
  protected readonly voice = inject(VoiceService);
  readonly floating = input(false);

  protected readonly state = computed(() =>
    this.voice.state() === 'connected'
      ? 'voice.connected'
      : this.voice.state() === 'reconnecting'
        ? 'voice.reconnecting'
        : 'voice.connecting',
  );
}
