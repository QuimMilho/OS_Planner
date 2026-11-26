import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { TeamStore, type Place } from '../data/team-store';
import { TreeStore } from '../data/tree-store';

export interface Crumb {
  label: string;
  link: string[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Where in the hierarchy the person is looking: read from the address, and for a page from the
 * space it belongs to. The rail, the sidebar and the breadcrumb all follow this one source.
 */
@Injectable({ providedIn: 'root' })
export class NavContext {
  private readonly router = inject(Router);
  private readonly teams = inject(TeamStore);
  private readonly tree = inject(TreeStore);

  readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
      startWith(this.router.url),
    ),
    { initialValue: '' },
  );

  /** Set on /app/t/:teamId and /app/t/:teamId/p/:projectId. */
  readonly route = computed(() => {
    const m = new RegExp(`^/app/t/(${UUID})(?:/p/(${UUID}))?`, 'i').exec(this.url());
    return { teamId: m?.[1] ?? null, projectId: m?.[2] ?? null };
  });

  private readonly pageId = computed(
    () => new RegExp(`^/app/p/(${UUID})`, 'i').exec(this.url())?.[1] ?? null,
  );

  /** The team (and projects) the current view sits in, if any. */
  readonly place = computed<Place | null>(() => {
    const { teamId, projectId } = this.route();
    if (teamId)
      return {
        team: this.teams.teamById().get(teamId) ?? null,
        projects: projectId ? this.teams.chainOf(projectId) : [],
      };
    const pageId = this.pageId();
    return pageId ? this.teams.placeOfSpace(this.tree.pageById().get(pageId)?.spaceId) : null;
  });

  /** The team whose sidebar to show. */
  readonly teamId = computed(() => this.place()?.team?.id ?? this.route().teamId);

  /** `Team / Project / Sub-project`, each linking to its level. */
  readonly crumbs = computed<Crumb[]>(() => {
    const place = this.place();
    if (!place?.team) return [];
    const team = place.team;
    return [
      { label: team.name, link: ['/app/t', team.id] },
      ...place.projects.map((p) => ({ label: p.name, link: ['/app/t', team.id, 'p', p.id] })),
    ];
  });
}
