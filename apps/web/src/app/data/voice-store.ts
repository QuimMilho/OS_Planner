import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  VOICE_EVENTS,
  type VoiceChannelStateDto,
  type VoiceParticipantDto,
} from '@os-planner/shared/lite';
import { RealtimeService } from '../core/realtime';
import { ChatStore } from './chat-store';
import { Features } from './features';

/**
 * Who is in each voice channel of the team on screen, for the sidebar and the voice page. It is the server's list (webhooks from
 * the media server), so people are shown even when this person is not connected. The room of every voice channel is joined by
 * ChatStore together with the text channels.
 */
@Injectable({ providedIn: 'root' })
export class VoiceStore {
  private readonly http = inject(HttpClient);
  private readonly rt = inject(RealtimeService);
  private readonly chat = inject(ChatStore);
  private readonly features = inject(Features);

  private readonly state = signal<ReadonlyMap<string, readonly VoiceParticipantDto[]>>(new Map());
  readonly total = computed(() => [...this.state().values()].reduce((n, p) => n + p.length, 0));

  constructor() {
    this.rt.on<VoiceChannelStateDto>(VOICE_EVENTS.participants).subscribe((s) => this.set(s));
    this.rt.resumed.subscribe(() => void this.refresh());
    effect(() => {
      const team = this.chat.activeTeam();
      const on = this.features.voice();
      untracked(() => {
        if (team && on) void this.refresh();
      });
    });
  }

  participants(channelId: string): readonly VoiceParticipantDto[] {
    return this.state().get(channelId) ?? [];
  }

  private set(s: VoiceChannelStateDto): void {
    this.state.update((old) => new Map(old).set(s.channelId, s.participants));
  }

  async refresh(): Promise<void> {
    const team = this.chat.activeTeam();
    if (!team || !this.features.voice()) return;
    try {
      const all = await firstValueFrom(
        this.http.get<VoiceChannelStateDto[]>(`/api/teams/${team}/voice`),
      );
      this.state.update((old) => {
        const next = new Map(old);
        for (const s of all) next.set(s.channelId, s.participants);
        return next;
      });
    } catch {
      /* offline: the last list stays until the next event */
    }
  }
}
