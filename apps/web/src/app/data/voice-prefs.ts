import { Injectable, signal } from '@angular/core';

const KEY = 'os_planner.voice';

export interface VoicePrefsData {
  micId: string;
  cameraId: string;
  speakerId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  /** 0–200 (%): applied to the microphone before it is sent. */
  inputVolume: number;
  pushToTalk: boolean;
  /** `KeyboardEvent.code` of the push-to-talk key. */
  pttKey: string;
  joinMuted: boolean;
}

const DEFAULTS: VoicePrefsData = {
  micId: '',
  cameraId: '',
  speakerId: '',
  noiseSuppression: true,
  echoCancellation: true,
  autoGain: true,
  inputVolume: 100,
  pushToTalk: false,
  pttKey: 'KeyV',
  joinMuted: false,
};

/** What this device uses for voice calls (which microphone, camera and speaker, and how they are treated). Remembered per device, never sent anywhere. */
@Injectable({ providedIn: 'root' })
export class VoicePrefs {
  readonly data = signal<VoicePrefsData>(this.read());

  private read(): VoicePrefsData {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<VoicePrefsData>;
      return { ...DEFAULTS, ...saved };
    } catch {
      return { ...DEFAULTS };
    }
  }

  set<K extends keyof VoicePrefsData>(key: K, value: VoicePrefsData[K]): void {
    this.data.update((d) => ({ ...d, [key]: value }));
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data()));
    } catch {
      /* the choice holds until the page closes */
    }
  }
}
