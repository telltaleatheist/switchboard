import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'agents', pathMatch: 'full' },
  {
    path: 'agents',
    loadComponent: () => import('./features/agents/agents.page').then((m) => m.AgentsPage),
  },
  {
    path: 'channels',
    loadComponent: () => import('./features/channels/channels.page').then((m) => m.ChannelsPage),
  },
  {
    path: 'live',
    loadComponent: () => import('./features/live/live.page').then((m) => m.LivePage),
  },
  {
    path: 'patch-requests',
    loadComponent: () =>
      import('./features/patch-requests/patch-requests.page').then((m) => m.PatchRequestsPage),
  },
  {
    path: 'archives',
    loadComponent: () => import('./features/archives/archives.page').then((m) => m.ArchivesPage),
  },
  { path: '**', redirectTo: 'agents' },
];
