import { Routes } from '@angular/router';

/**
 * One screen. Agents, channels, live view and archives were four lists you
 * read to answer one question — who is on which line, and what are they
 * saying — so they are one console now; everything you configure rather than
 * operate lives in dialogs on top of it.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/console/console.page').then((m) => m.ConsolePage),
  },
  { path: '**', redirectTo: '' },
];
