import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { RoleDto } from '@os-planner/shared';
import { mentionToken, type MentionKind } from '@os-planner/shared/chat';
import { AuthStore } from '../core/auth-store';
import { ChatStore } from './chat-store';
import { PresenceStore } from './presence-store';
import { RolesStore } from './roles-store';
import { TeamStore } from './team-store';

/** One thing the `@` list offers. */
export interface MentionSuggestion {
  kind: MentionKind;
  id: string | null;
  /** What is shown and inserted into the box: `@Ana`, `@everyone`. */
  label: string;
  /** The token that goes into the message when it is sent. */
  token: string;
  color: string | null;
  /** For people: online, idle or offline. */
  status?: string;
}

const MAX_SUGGESTIONS = 8;

/**
 * Names for the mentions in messages, and the list the composer offers. People come from the team the person is looking at
 * (nickname first, as everywhere in chat) and roles from its role list; both follow renames because messages hold ids.
 */
@Injectable({ providedIn: 'root' })
export class MentionDirectory {
  private readonly chat = inject(ChatStore);
  private readonly teams = inject(TeamStore);
  private readonly rolesStore = inject(RolesStore);
  private readonly auth = inject(AuthStore);
  private readonly presence = inject(PresenceStore);

  private readonly loaded = signal<{ teamId: string; roles: RoleDto[] } | null>(null);
  readonly roles = computed(() => {
    const l = this.loaded();
    return l && l.teamId === this.chat.activeTeam() ? l.roles : [];
  });
  readonly members = computed(() => {
    const team = this.chat.activeTeam();
    this.teams.members();
    return team ? this.teams.membersOf(team) : [];
  });
  private readonly byUser = computed(() => new Map(this.members().map((m) => [m.userId, m])));
  private readonly byRole = computed(() => new Map(this.roles().map((r) => [r.id, r])));
  /** The roles the person holds in the team on screen. */
  private readonly mine = computed(
    () => new Set(this.byUser().get(this.auth.userId() ?? '')?.roleIds ?? []),
  );

  constructor() {
    effect(() => {
      const teamId = this.chat.activeTeam();
      untracked(() => {
        if (!teamId || this.loaded()?.teamId === teamId) return;
        this.rolesStore.roles({ kind: 'team', id: teamId }).then(
          (roles) => this.loaded.set({ teamId, roles }),
          () => undefined, // offline or no access: people still work, roles are simply not offered
        );
      });
    });
  }

  userName(id: string | null): string | undefined {
    const m = id ? this.byUser().get(id) : undefined;
    return m ? m.nickname || m.displayName : undefined;
  }

  role(id: string | null): RoleDto | undefined {
    return id ? this.byRole().get(id) : undefined;
  }

  isMe(userId: string | null): boolean {
    return userId !== null && userId === this.auth.userId();
  }

  inRole(roleId: string | null): boolean {
    return roleId !== null && this.mine().has(roleId);
  }

  /** What to write for a mention: the name when it is known, a generic word when it is not. */
  label(kind: MentionKind, id: string | null, generic: { user: string; role: string }): string {
    if (kind === 'everyone' || kind === 'here') return `@${kind}`;
    if (kind === 'user') return `@${this.userName(id) ?? generic.user}`;
    return `@${this.role(id)?.name ?? generic.role}`;
  }

  /** The list for what was typed after the `@`. */
  suggestions(typed: string, canEveryone: boolean): MentionSuggestion[] {
    const q = typed.trim().toLowerCase();
    const hit = (name: string): boolean => !q || name.toLowerCase().includes(q);
    const out: MentionSuggestion[] = [];
    if (canEveryone) {
      for (const kind of ['everyone', 'here'] as const)
        if (hit(kind))
          out.push({ kind, id: null, label: `@${kind}`, token: mentionToken(kind), color: null });
    }
    for (const r of this.roles())
      if (!r.isEveryone && (r.mentionable || canEveryone) && hit(r.name))
        out.push({
          kind: 'role',
          id: r.id,
          label: `@${r.name}`,
          token: mentionToken('role', r.id),
          color: r.color,
        });
    for (const m of this.members()) {
      const name = m.nickname || m.displayName;
      if (m.userId !== this.auth.userId() && (hit(name) || hit(m.displayName)))
        out.push({
          kind: 'user',
          id: m.userId,
          label: `@${name}`,
          token: mentionToken('user', m.userId),
          color: null,
          status: this.presence.statusOf(m.userId),
        });
    }
    // people whose name starts with what was typed come first
    const starts = (s: MentionSuggestion): number =>
      s.label.slice(1).toLowerCase().startsWith(q) ? 0 : 1;
    return out.sort((a, b) => starts(a) - starts(b)).slice(0, MAX_SUGGESTIONS);
  }
}
