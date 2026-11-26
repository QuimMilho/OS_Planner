import type { Routes } from '@angular/router';
import { adminMatch, authGuard, guestGuard } from './core/guards';

export const routes: Routes = [
  { path: '', title: 'OS_Planner', loadComponent: () => import('./features/site/site').then((m) => m.Landing) },
  { path: 'download', title: 'OS_Planner', loadComponent: () => import('./features/site/site').then((m) => m.Download) },
  { path: 'login', title: 'OS_Planner', canActivate: [guestGuard], loadComponent: () => import('./features/auth/auth-pages').then((m) => m.Login) },
  { path: 'register', title: 'OS_Planner', canActivate: [guestGuard], loadComponent: () => import('./features/auth/auth-pages').then((m) => m.Register) },
  { path: 'invite/:token', title: 'OS_Planner', loadComponent: () => import('./features/auth/invite-page').then((m) => m.InvitePage) },
  { path: 'verify-email', title: 'OS_Planner', loadComponent: () => import('./features/auth/auth-pages').then((m) => m.VerifyEmail) },
  { path: 'forgot-password', title: 'OS_Planner', loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ForgotPassword) },
  { path: 'reset-password', title: 'OS_Planner', loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ResetPassword) },
  {
    path: 'app',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', title: 'OS_Planner', loadComponent: () => import('./features/shell/home').then((m) => m.Home) },
      { path: 'p/:id', title: 'OS_Planner', loadComponent: () => import('./features/editor/editor-page').then((m) => m.EditorPage) },
      { path: 't/:teamId/settings', title: 'OS_Planner', loadComponent: () => import('./features/team/settings-pages').then((m) => m.TeamSettingsPage) },
      { path: 't/:teamId/p/:projectId/settings', title: 'OS_Planner', loadComponent: () => import('./features/team/settings-pages').then((m) => m.ProjectSettingsPage) },
      { path: 't/:teamId', title: 'OS_Planner', loadComponent: () => import('./features/team/team-page').then((m) => m.TeamPage) },
      { path: 't/:teamId/p/:projectId', title: 'OS_Planner', loadComponent: () => import('./features/team/team-page').then((m) => m.TeamPage) },
      { path: 'directory', title: 'OS_Planner', loadComponent: () => import('./features/team/directory-page').then((m) => m.DirectoryPage) },
      { path: 'search', title: 'OS_Planner', loadComponent: () => import('./features/search/search-page').then((m) => m.SearchPage) },
      { path: 'trash', title: 'OS_Planner', loadComponent: () => import('./features/trash/trash-page').then((m) => m.TrashPage) },
      { path: 'settings', title: 'OS_Planner', loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage) },
      // Only administrators match; everybody else falls through to the "not found" page at the same address.
      { path: 'admin', title: 'OS_Planner', canMatch: [adminMatch], loadComponent: () => import('./features/admin/admin-page').then((m) => m.AdminPage) },
      { path: '**', title: 'OS_Planner', loadComponent: () => import('./features/shell/not-found').then((m) => m.NotFoundPage) },
    ],
  },
  { path: 'admin', redirectTo: 'app/admin' },
  { path: '**', redirectTo: '' },
];
