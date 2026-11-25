import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/guards';

export const routes: Routes = [
  { path: '', title: 'Notes', loadComponent: () => import('./features/site/site').then((m) => m.Landing) },
  { path: 'download', title: 'Notes', loadComponent: () => import('./features/site/site').then((m) => m.Download) },
  { path: 'login', title: 'Notes', canActivate: [guestGuard], loadComponent: () => import('./features/auth/auth-pages').then((m) => m.Login) },
  { path: 'register', title: 'Notes', canActivate: [guestGuard], loadComponent: () => import('./features/auth/auth-pages').then((m) => m.Register) },
  { path: 'verify-email', title: 'Notes', loadComponent: () => import('./features/auth/auth-pages').then((m) => m.VerifyEmail) },
  { path: 'forgot-password', title: 'Notes', loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ForgotPassword) },
  { path: 'reset-password', title: 'Notes', loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ResetPassword) },
  {
    path: 'app',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', title: 'Notes', loadComponent: () => import('./features/shell/home').then((m) => m.Home) },
      { path: 'p/:id', title: 'Notes', loadComponent: () => import('./features/editor/editor-page').then((m) => m.EditorPage) },
      { path: 'search', title: 'Notes', loadComponent: () => import('./features/search/search-page').then((m) => m.SearchPage) },
      { path: 'trash', title: 'Notes', loadComponent: () => import('./features/trash/trash-page').then((m) => m.TrashPage) },
      { path: 'settings', title: 'Notes', loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
