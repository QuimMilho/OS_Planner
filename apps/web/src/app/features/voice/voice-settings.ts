import { Component, OnDestroy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { VoiceService } from '../../data/voice-service';
import { VoicePrefs, type VoicePrefsData } from '../../data/voice-prefs';

interface Device {
  id: string;
  label: string;
}

/** Settings → Voice & video: which microphone, camera and speaker, how the voice is treated, push to talk, and a microphone test. */
@Component({
  selector: 'app-voice-settings',
  imports: [FormsModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div class="vs" data-voice-settings>
      @if (!labelled()) {
        <p class="muted">{{ 'voice.settings.allow' | transloco }}</p>
        <button mat-stroked-button type="button" (click)="allow()" data-action="voice-allow">
          <mat-icon>mic</mat-icon>{{ 'voice.settings.allowButton' | transloco }}
        </button>
      }
      @if (denied()) {
        <p class="warn" role="alert" data-voice-denied>{{ 'voice.blocked.mic' | transloco }}</p>
      }

      <label>
        {{ 'voice.settings.mic' | transloco }}
        <select
          [ngModel]="p().micId"
          (ngModelChange)="set('micId', $event)"
          name="mic"
          data-field="voice-mic"
        >
          <option value="">{{ 'voice.settings.default' | transloco }}</option>
          @for (d of mics(); track d.id) {
            <option [value]="d.id">{{ d.label }}</option>
          }
        </select>
      </label>
      <label>
        {{ 'voice.settings.camera' | transloco }}
        <select
          [ngModel]="p().cameraId"
          (ngModelChange)="set('cameraId', $event)"
          name="cam"
          data-field="voice-camera"
        >
          <option value="">{{ 'voice.settings.default' | transloco }}</option>
          @for (d of cameras(); track d.id) {
            <option [value]="d.id">{{ d.label }}</option>
          }
        </select>
      </label>
      @if (speakersSupported) {
        <label>
          {{ 'voice.settings.speaker' | transloco }}
          <select
            [ngModel]="p().speakerId"
            (ngModelChange)="set('speakerId', $event)"
            name="spk"
            data-field="voice-speaker"
          >
            <option value="">{{ 'voice.settings.default' | transloco }}</option>
            @for (d of speakers(); track d.id) {
              <option [value]="d.id">{{ d.label }}</option>
            }
          </select>
        </label>
      }

      <label>
        {{ 'voice.settings.inputVolume' | transloco }}: {{ p().inputVolume }}%
        <input
          type="range"
          min="0"
          max="200"
          step="5"
          [ngModel]="p().inputVolume"
          (ngModelChange)="volume($event)"
          name="vol"
          data-field="voice-volume"
        />
      </label>

      <label class="check">
        <input
          type="checkbox"
          [ngModel]="p().noiseSuppression"
          (ngModelChange)="processing('noiseSuppression', $event)"
          name="ns"
          data-field="voice-noise"
        />
        {{ 'voice.settings.noise' | transloco }}
      </label>
      <label class="check">
        <input
          type="checkbox"
          [ngModel]="p().echoCancellation"
          (ngModelChange)="processing('echoCancellation', $event)"
          name="ec"
        />
        {{ 'voice.settings.echo' | transloco }}
      </label>
      <label class="check">
        <input
          type="checkbox"
          [ngModel]="p().autoGain"
          (ngModelChange)="processing('autoGain', $event)"
          name="ag"
        />
        {{ 'voice.settings.gain' | transloco }}
      </label>
      <label class="check">
        <input
          type="checkbox"
          [ngModel]="p().joinMuted"
          (ngModelChange)="set('joinMuted', $event)"
          name="jm"
          data-field="voice-join-muted"
        />
        {{ 'voice.settings.joinMuted' | transloco }}
      </label>
      <label class="check">
        <input
          type="checkbox"
          [ngModel]="p().pushToTalk"
          (ngModelChange)="set('pushToTalk', $event)"
          name="ptt"
          data-field="voice-ptt"
        />
        {{ 'voice.settings.ptt' | transloco }}
      </label>
      @if (p().pushToTalk) {
        <div class="ptt">
          <span>{{ 'voice.settings.pttKey' | transloco }}:</span>
          <kbd data-voice-ptt-key>{{ keyName(p().pttKey) }}</kbd>
          <button
            mat-stroked-button
            type="button"
            (click)="capture.set(true)"
            data-action="voice-ptt-set"
          >
            {{ (capture() ? 'voice.settings.pressKey' : 'voice.settings.changeKey') | transloco }}
          </button>
        </div>
        <p class="muted hint">{{ 'voice.settings.pttHint' | transloco }}</p>
      }

      <div class="test">
        <button
          mat-stroked-button
          type="button"
          (click)="testing() ? stopTest() : startTest()"
          data-action="voice-test"
        >
          <mat-icon>{{ testing() ? 'stop' : 'graphic_eq' }}</mat-icon>{{
            (testing() ? 'voice.settings.testStop' : 'voice.settings.test') | transloco
          }}
        </button>
        <div
          class="meter"
          role="meter"
          aria-valuemin="0"
          aria-valuemax="100"
          [attr.aria-valuenow]="level()"
          [attr.aria-label]="'voice.settings.test' | transloco"
        >
          <span [style.width.%]="level()"></span>
        </div>
      </div>
      <p class="muted hint">{{ 'voice.settings.privacy' | transloco }}</p>
    </div>
  `,
  styles: `
    .vs {
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
    label.check {
      flex-direction: row;
      align-items: center;
      gap: 8px;
      color: var(--text);
      font-size: 14px;
    }
    select {
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
    }
    .warn {
      color: var(--mat-sys-error);
    }
    .hint {
      margin: -6px 0 0;
      font-size: 12.5px;
    }
    .ptt,
    .test {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    kbd {
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-3);
    }
    .meter {
      flex: 1;
      height: 10px;
      border-radius: 5px;
      background: var(--surface-3);
      overflow: hidden;
    }
    .meter span {
      display: block;
      height: 100%;
      background: var(--accent);
      transition: width 0.08s linear;
    }
  `,
})
export class VoiceSettings implements OnDestroy {
  private readonly prefs = inject(VoicePrefs);
  private readonly voice = inject(VoiceService);

  protected readonly p = this.prefs.data;
  protected readonly mics = signal<Device[]>([]);
  protected readonly cameras = signal<Device[]>([]);
  protected readonly speakers = signal<Device[]>([]);
  /** Device names are only given once the browser has allowed the microphone. */
  protected readonly labelled = signal(false);
  protected readonly denied = signal(false);
  protected readonly capture = signal(false);
  protected readonly testing = signal(false);
  protected readonly level = signal(0);
  protected readonly speakersSupported =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.capture()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') this.set('pttKey', e.code);
    this.capture.set(false);
  };
  private readonly onChange = (): void => void this.list();

  constructor() {
    void this.list();
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onChange);
    addEventListener('keydown', this.onKey, true);
  }

  ngOnDestroy(): void {
    this.stopTest();
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onChange);
    removeEventListener('keydown', this.onKey, true);
  }

  protected set<K extends keyof VoicePrefsData>(key: K, value: VoicePrefsData[K]): void {
    this.prefs.set(key, value);
    if (key === 'micId' || key === 'cameraId' || key === 'speakerId')
      void this.voice.applyDevices();
    if (key === 'micId' && this.testing()) void this.startTest();
  }

  protected volume(v: number): void {
    this.prefs.set('inputVolume', Number(v));
    void this.voice.applyGain();
  }

  protected processing(
    key: 'noiseSuppression' | 'echoCancellation' | 'autoGain',
    value: boolean,
  ): void {
    this.prefs.set(key, value);
    void this.voice.applyProcessing();
  }

  protected keyName(code: string): string {
    return code.replace(/^Key/, '').replace(/^Digit/, '');
  }

  private async list(): Promise<void> {
    try {
      const all = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications',
      );
      this.labelled.set(all.some((d) => d.label));
      const pick = (kind: MediaDeviceKind, name: string): Device[] =>
        all
          .filter((d) => d.kind === kind)
          .map((d, i) => ({ id: d.deviceId, label: d.label || `${name} ${i + 1}` }));
      this.mics.set(pick('audioinput', 'Microphone'));
      this.cameras.set(pick('videoinput', 'Camera'));
      this.speakers.set(pick('audiooutput', 'Speaker'));
    } catch {
      /* no devices to list */
    }
  }

  /** Asks the browser for the microphone once, so it will tell the names of the devices. */
  protected async allow(): Promise<void> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      this.denied.set(false);
    } catch {
      this.denied.set(true);
    }
    await this.list();
  }

  protected async startTest(): Promise<void> {
    this.stopTest();
    try {
      const id = this.p().micId;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(id ? { deviceId: { exact: id } } : {}),
          noiseSuppression: this.p().noiseSuppression,
          echoCancellation: this.p().echoCancellation,
          autoGainControl: this.p().autoGain,
        },
      });
      this.denied.set(false);
      this.ctx = new AudioContext();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      const gain = this.ctx.createGain();
      gain.gain.value = this.p().inputVolume / 100;
      this.ctx.createMediaStreamSource(this.stream).connect(gain).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      this.testing.set(true);
      const tick = (): void => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        this.level.set(Math.min(100, Math.round((peak / 128) * 140)));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
      await this.list();
    } catch {
      this.denied.set(true);
      this.testing.set(false);
    }
  }

  protected stopTest(): void {
    cancelAnimationFrame(this.raf);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.testing.set(false);
    this.level.set(0);
  }
}
