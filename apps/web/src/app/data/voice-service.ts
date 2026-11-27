import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { Room, Track, TrackProcessor } from 'livekit-client';
import {
  VOICE_EVENTS,
  VOICE_LIMITS,
  type VoiceModeratedEvent,
  type VoiceTokenDto,
} from '@os-planner/shared/lite';
import { AppUpdates } from '../core/app-updates';
import { AuthStore, toProblem } from '../core/auth-store';
import { Notify } from '../core/notify';
import { RealtimeService } from '../core/realtime';
import { ChatStore } from './chat-store';
import { Features } from './features';
import { VoicePrefs } from './voice-prefs';

type LiveKit = typeof import('livekit-client');

export type VoiceState = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type VoiceQualityLevel = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

/** One person in the call, as the voice page and the bar show them. */
export interface VoiceTile {
  id: string;
  name: string;
  color: string;
  local: boolean;
  speaking: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  /** A moderator keeps the microphone off. */
  modMuted: boolean;
  quality: VoiceQualityLevel;
  cameraTrack: Track | null;
  screenTrack: Track | null;
}

/** Why a join did not work, as a translation key. */
export function voiceErrorKey(code: string, status = 0): string {
  switch (code) {
    case 'offline':
      return 'common.offlineAction';
    case 'channel_full':
      return 'voice.channelFull';
    case 'team_voice_full':
      return 'voice.teamFull';
    case 'channel_archived':
      return 'voice.archived';
    case 'voice_unavailable':
      return 'errors.voiceUnavailable';
    default:
      return status === 403
        ? 'voice.noPermission'
        : status === 404
          ? 'errors.voiceUnavailable'
          : 'voice.connectFailed';
  }
}

/** Scales the microphone before it is sent (the "input volume" setting). */
class GainProcessor implements TrackProcessor<Track.Kind.Audio> {
  readonly name = 'os-planner-gain';
  processedTrack?: MediaStreamTrack;
  private ctx?: AudioContext;
  private gain?: GainNode;

  constructor(private volume: number) {}

  async init(opts: { track: MediaStreamTrack }): Promise<void> {
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    const out = this.ctx.createMediaStreamDestination();
    source.connect(this.gain).connect(out);
    this.processedTrack = out.stream.getAudioTracks()[0];
  }
  async restart(opts: { track: MediaStreamTrack }): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }
  async destroy(): Promise<void> {
    await this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.gain = undefined;
  }
  setVolume(v: number): void {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }
}

/** Reasons that mean "do not come back by yourself": the person left, was removed, or the channel is gone. */
const FINAL = new Set([
  'CLIENT_INITIATED',
  'PARTICIPANT_REMOVED',
  'ROOM_DELETED',
  'DUPLICATE_IDENTITY',
  'ROOM_CLOSED',
  'SERVER_SHUTDOWN',
]);

/**
 * The person's voice connection: at most one at a time, kept while they move around the app. The media server's client library is
 * loaded only when somebody joins. Who may do what is decided by the server's token; what this class shows is what the room reports.
 */
@Injectable({ providedIn: 'root' })
export class VoiceService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthStore);
  private readonly rt = inject(RealtimeService);
  private readonly chat = inject(ChatStore);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);
  private readonly features = inject(Features);
  readonly prefs = inject(VoicePrefs);

  readonly state = signal<VoiceState>('idle');
  readonly channelId = signal<string | null>(null);
  readonly tiles = signal<VoiceTile[]>([]);
  /** The person turned their own microphone off (or never turned it on). */
  readonly muted = signal(false);
  readonly deafened = signal(false);
  readonly cameraOn = signal(false);
  readonly sharing = signal(false);
  /** The token let the person publish these (false: the control is off). */
  readonly canSpeak = signal(false);
  readonly canVideo = signal(false);
  readonly canShare = signal(false);
  /** A moderator keeps the microphone off; the name of who did it when this device saw it. */
  readonly modMuted = signal(false);
  readonly mutedBy = signal<string | null>(null);
  /** The browser refused the microphone, camera or screen: what to do about it. */
  readonly blocked = signal<'mic' | 'camera' | 'screen' | null>(null);
  readonly audioBlocked = signal(false);
  readonly quality = signal<VoiceQualityLevel>('unknown');
  /** True while the push-to-talk key is held. */
  readonly talking = signal(false);

  readonly channel = computed(() => {
    const id = this.channelId();
    return id ? (this.chat.channelById().get(id) ?? null) : null;
  });
  readonly active = computed(() => this.state() !== 'idle');

  private room: Room | null = null;
  private lk: LiveKit | null = null;
  private audioHost: HTMLElement | null = null;
  private gain: GainProcessor | null = null;
  private left = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private joining: Promise<boolean> | null = null;

  constructor() {
    // An app update's reload would drop the call, so it waits (registered from here so the voice code stays out of the first load).
    inject(AppUpdates).holdWhile(() => this.active());
    this.rt
      .on<VoiceModeratedEvent>(VOICE_EVENTS.moderated)
      .subscribe((e) => void this.moderated(e));
    // signing out ends the call
    effect(() => {
      if (this.auth.status() === 'anon') untracked(() => void this.leave());
    });
    effect(() => {
      if (!this.features.voice() && this.features.known()) untracked(() => void this.leave());
    });
    // a closed tab ends the call at once, instead of after the media server's timeout
    addEventListener('pagehide', () => void this.room?.disconnect());
    addEventListener('keydown', (e) => this.key(e, true));
    addEventListener('keyup', (e) => this.key(e, false));
    addEventListener('blur', () => this.releaseTalk());
  }

  // ---------------------------------------------------------------- joining and leaving

  /** Joins the channel (leaving the one the person is in). Resolves true when connected. */
  join(channelId: string): Promise<boolean> {
    if (this.channelId() === channelId && this.state() !== 'idle')
      return this.joining ?? Promise.resolve(true);
    this.joining = this.start(channelId).finally(() => (this.joining = null));
    return this.joining;
  }

  private async start(channelId: string): Promise<boolean> {
    await this.leave();
    this.left = false;
    this.retries = 0;
    this.channelId.set(channelId);
    this.state.set('connecting');
    return this.connect(channelId);
  }

  private async connect(channelId: string): Promise<boolean> {
    let token: VoiceTokenDto;
    try {
      token = await firstValueFrom(
        this.http.post<VoiceTokenDto>(`/api/channels/${channelId}/voice/token`, {}),
      );
    } catch (e) {
      const p = toProblem(e);
      return this.failed(voiceErrorKey(p.code, p.status));
    }
    if (this.left || this.channelId() !== channelId) return false;
    try {
      const lk = (this.lk ??= await import('livekit-client'));
      const p = this.prefs.data();
      const room = new lk.Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          deviceId: p.micId || undefined,
          noiseSuppression: p.noiseSuppression,
          echoCancellation: p.echoCancellation,
          autoGainControl: p.autoGain,
        },
        videoCaptureDefaults: { deviceId: p.cameraId || undefined },
        audioOutput: { deviceId: p.speakerId || undefined },
        publishDefaults: { audioPreset: { maxBitrate: token.bitrate }, dtx: true, red: true },
      });
      this.room = room;
      this.wire(room, lk);
      this.canSpeak.set(token.canSpeak);
      this.canVideo.set(token.canVideo);
      this.canShare.set(token.canShare);
      this.modMuted.set(token.mutedByModerator);
      await room.connect(token.url, token.token);
      if (this.left || this.room !== room) return false;
      this.state.set('connected');
      this.retries = 0;
      this.refresh();
      await this.startMicrophone(token.canSpeak);
      return true;
    } catch {
      this.dispose();
      return this.failed('voice.connectFailed');
    }
  }

  private failed(key: string): false {
    this.notify.error(key);
    this.channelId.set(null);
    this.state.set('idle');
    return false;
  }

  /** Leaves the call (if in one). */
  async leave(): Promise<void> {
    this.left = true;
    clearTimeout(this.retryTimer);
    const room = this.room;
    this.dispose();
    this.channelId.set(null);
    this.state.set('idle');
    await room?.disconnect().catch(() => undefined);
  }

  private dispose(): void {
    const room = this.room;
    this.room = null;
    this.gain = null;
    room?.removeAllListeners();
    void room?.disconnect().catch(() => undefined);
    this.audioHost?.remove();
    this.audioHost = null;
    this.tiles.set([]);
    this.cameraOn.set(false);
    this.sharing.set(false);
    this.deafened.set(false);
    this.muted.set(false);
    this.modMuted.set(false);
    this.mutedBy.set(null);
    this.blocked.set(null);
    this.audioBlocked.set(false);
    this.quality.set('unknown');
    this.talking.set(false);
  }

  private async startMicrophone(canSpeak: boolean): Promise<void> {
    const room = this.room;
    if (!room || !canSpeak || this.modMuted()) {
      this.muted.set(true);
      return;
    }
    const quiet = this.prefs.data().joinMuted || this.prefs.data().pushToTalk;
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      await this.applyGain();
      if (quiet) await room.localParticipant.setMicrophoneEnabled(false);
      this.muted.set(quiet);
    } catch (e) {
      this.muted.set(true);
      this.blocked.set(this.denied(e) ? 'mic' : null);
    }
    this.refresh();
  }

  private denied(e: unknown): boolean {
    const name = (e as { name?: string } | null)?.name;
    return (
      name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
    );
  }

  // ---------------------------------------------------------------- what the room tells us

  private wire(room: Room, lk: LiveKit): void {
    const E = lk.RoomEvent;
    const refresh = () => this.refresh();
    for (const e of [
      E.ParticipantConnected,
      E.ParticipantDisconnected,
      E.ActiveSpeakersChanged,
      E.TrackMuted,
      E.TrackUnmuted,
      E.LocalTrackPublished,
      E.LocalTrackUnpublished,
      E.ParticipantAttributesChanged,
      E.ConnectionQualityChanged,
      E.TrackPublished,
      E.TrackUnpublished,
    ])
      room.on(e, refresh);
    room.on(E.TrackSubscribed, (track) => {
      if (track.kind === lk.Track.Kind.Audio) this.attachAudio(track);
      this.refresh();
    });
    room.on(E.TrackUnsubscribed, (track) => {
      for (const el of track.detach()) el.remove();
      this.refresh();
    });
    room.on(E.ParticipantPermissionsChanged, () => {
      this.permissions();
      this.refresh();
    });
    room.on(E.AudioPlaybackStatusChanged, () => this.audioBlocked.set(!room.canPlaybackAudio));
    room.on(E.Reconnecting, () => this.state.set('reconnecting'));
    room.on(E.Reconnected, () => {
      this.state.set('connected');
      this.refresh();
    });
    room.on(E.MediaDevicesError, (e) => {
      if (this.denied(e)) this.blocked.set('mic');
    });
    room.on(
      E.Disconnected,
      (reason) =>
        void this.disconnected(
          room,
          reason === undefined ? '' : (lk.DisconnectReason[reason] ?? ''),
        ),
    );
  }

  private async disconnected(room: Room, reason: string): Promise<void> {
    if (this.room !== room) return;
    const channelId = this.channelId();
    this.dispose();
    if (this.left || !channelId) return;
    if (FINAL.has(reason)) {
      this.channelId.set(null);
      this.state.set('idle');
      if (reason !== 'CLIENT_INITIATED') this.notify.info('voice.ended');
      return;
    }
    // The connection broke (network, the media server restarted): come back with a new token, a few times.
    this.state.set('reconnecting');
    if (this.retries >= 3) {
      this.channelId.set(null);
      this.state.set('idle');
      this.notify.error('voice.connectionLost');
      return;
    }
    const wait = [2000, 5000, 10_000][this.retries++]!;
    this.retryTimer = setTimeout(() => {
      if (!this.left && this.channelId() === channelId) void this.connect(channelId);
    }, wait);
  }

  private permissions(): void {
    const room = this.room;
    if (!room) return;
    const sources = room.localParticipant.permissions?.canPublishSources ?? [];
    // TrackSource: 1 camera, 2 microphone, 3 screen share
    this.canSpeak.set(
      room.localParticipant.permissions?.canPublish !== false && sources.includes(2),
    );
    this.canVideo.set(
      room.localParticipant.permissions?.canPublish !== false && sources.includes(1),
    );
    this.canShare.set(
      room.localParticipant.permissions?.canPublish !== false && sources.includes(3),
    );
    const mod = room.localParticipant.attributes?.[VOICE_LIMITS.attributeModMuted] === '1';
    this.modMuted.set(mod);
    if (!mod) this.mutedBy.set(null);
    if (!this.canSpeak()) this.muted.set(true);
  }

  private refresh(): void {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    const S = lk.Track.Source;
    const all = [room.localParticipant, ...room.remoteParticipants.values()];
    this.tiles.set(
      all.map((p) => {
        let color = '#5f6b7a';
        try {
          color = (JSON.parse(p.metadata ?? '{}') as { color?: string }).color ?? color;
        } catch {
          /* no colour */
        }
        return {
          id: p.identity,
          name: p.name || p.identity,
          color,
          local: p === room.localParticipant,
          speaking: p.isSpeaking,
          mic: p.isMicrophoneEnabled,
          camera: p.isCameraEnabled,
          screen: p.isScreenShareEnabled,
          modMuted: p.attributes?.[VOICE_LIMITS.attributeModMuted] === '1',
          quality: p.connectionQuality as VoiceQualityLevel,
          cameraTrack: p.getTrackPublication(S.Camera)?.track ?? null,
          screenTrack: p.getTrackPublication(S.ScreenShare)?.track ?? null,
        } satisfies VoiceTile;
      }),
    );
    this.quality.set(room.localParticipant.connectionQuality as VoiceQualityLevel);
    this.cameraOn.set(room.localParticipant.isCameraEnabled);
    this.sharing.set(room.localParticipant.isScreenShareEnabled);
    this.audioBlocked.set(!room.canPlaybackAudio);
    this.permissions();
  }

  private attachAudio(track: Track): void {
    this.audioHost ??= Object.assign(document.createElement('div'), { hidden: true });
    this.audioHost.dataset['voiceAudio'] = '';
    if (!this.audioHost.isConnected) document.body.appendChild(this.audioHost);
    const el = track.attach() as HTMLMediaElement;
    el.muted = this.deafened();
    this.audioHost.appendChild(el);
  }

  /** Browsers hold back sound until the person did something on the page: this is that something. */
  async startAudio(): Promise<void> {
    await this.room?.startAudio().catch(() => undefined);
    this.audioBlocked.set(!(this.room?.canPlaybackAudio ?? true));
  }

  // ---------------------------------------------------------------- controls

  async toggleMute(): Promise<void> {
    const room = this.room;
    if (!room || !this.canSpeak() || this.modMuted()) return;
    await this.setMute(!this.muted());
  }

  private async setMute(muted: boolean): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
      if (!muted) await this.applyGain();
      this.muted.set(muted);
      this.blocked.set(null);
    } catch (e) {
      this.blocked.set(this.denied(e) ? 'mic' : null);
    }
    this.refresh();
  }

  /** Deafening switches off everything coming in, and the microphone with it (as in the usual chat apps); undoing it brings the microphone back. */
  async toggleDeafen(): Promise<void> {
    const on = !this.deafened();
    this.deafened.set(on);
    for (const el of this.audioHost?.querySelectorAll('audio,video') ?? [])
      (el as HTMLMediaElement).muted = on;
    if (on) {
      if (!this.muted() && this.room) await this.setMute(true);
      this.deafMuted = true;
    } else if (this.deafMuted) {
      this.deafMuted = false;
      if (this.canSpeak() && !this.modMuted()) await this.setMute(false);
    }
  }
  private deafMuted = false;

  async toggleCamera(): Promise<void> {
    const room = this.room;
    if (!room || !this.canVideo()) return;
    try {
      await room.localParticipant.setCameraEnabled(!this.cameraOn());
      this.blocked.set(null);
    } catch (e) {
      this.blocked.set(this.denied(e) ? 'camera' : null);
      if (!this.denied(e)) this.notify.error('voice.cameraFailed');
    }
    this.refresh();
  }

  async toggleShare(): Promise<void> {
    const room = this.room;
    if (!room || !this.canShare()) return;
    try {
      await room.localParticipant.setScreenShareEnabled(!this.sharing(), { audio: true });
      this.blocked.set(null);
    } catch (e) {
      // closing the browser's picker is not an error
      if (this.denied(e) && (e as { message?: string }).message?.includes('denied by system'))
        this.blocked.set('screen');
    }
    this.refresh();
  }

  /** Applies the device choices (made in Settings) to the running call. */
  async applyDevices(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const p = this.prefs.data();
    try {
      if (p.micId) await room.switchActiveDevice('audioinput', p.micId);
      if (p.cameraId) await room.switchActiveDevice('videoinput', p.cameraId);
      if (p.speakerId) await room.switchActiveDevice('audiooutput', p.speakerId);
    } catch {
      /* a device that went away: the call keeps the one it has */
    }
    await this.applyGain();
  }

  /** Noise suppression, echo cancellation, automatic gain: the microphone is restarted with the new settings. */
  async applyProcessing(): Promise<void> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    const p = this.prefs.data();
    const track = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.audioTrack;
    try {
      await track?.restartTrack({
        noiseSuppression: p.noiseSuppression,
        echoCancellation: p.echoCancellation,
        autoGainControl: p.autoGain,
      });
    } catch {
      /* the microphone is gone; the next toggle says so */
    }
  }

  async applyGain(): Promise<void> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    const track = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.audioTrack;
    if (!track) return;
    const volume = this.prefs.data().inputVolume / 100;
    if (this.gain) return this.gain.setVolume(volume);
    if (volume === 1) return;
    this.gain = new GainProcessor(volume);
    try {
      await track.setProcessor(this.gain);
    } catch {
      this.gain = null;
    }
  }

  // ---------------------------------------------------------------- push to talk

  private key(e: KeyboardEvent, down: boolean): void {
    const p = this.prefs.data();
    if (!p.pushToTalk || this.state() !== 'connected' || e.code !== p.pttKey || e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (
      down &&
      target &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    )
      return;
    if (!this.canSpeak() || this.modMuted()) return;
    this.talking.set(down);
    void this.setMute(!down);
  }

  private releaseTalk(): void {
    if (this.talking()) {
      this.talking.set(false);
      void this.setMute(true);
    }
  }

  // ---------------------------------------------------------------- moderators

  private async moderated(e: VoiceModeratedEvent): Promise<void> {
    if (e.channelId !== this.channelId()) return;
    if (e.action === 'mute') {
      this.mutedBy.set(e.byName);
      this.modMuted.set(true);
      this.muted.set(true);
      this.notify.info('voice.mutedBy', { name: e.byName });
    } else if (e.action === 'unmute') {
      this.mutedBy.set(null);
      this.modMuted.set(false);
      this.notify.info('voice.unmutedBy', { name: e.byName });
    } else if (e.action === 'move' && e.toChannelId) {
      const onPage = this.router.url.startsWith(`/app/v/${e.channelId}`);
      this.notify.info('voice.movedBy', { name: e.byName });
      if ((await this.join(e.toChannelId)) && onPage)
        void this.router.navigate(['/app/v', e.toChannelId]);
    } else if (e.action === 'disconnect') {
      this.left = true;
      await this.leave();
      this.notify.info(e.byUserId ? 'voice.disconnectedBy' : 'voice.removed', { name: e.byName });
    }
  }
}
