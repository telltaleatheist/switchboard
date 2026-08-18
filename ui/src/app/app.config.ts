import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Hash routing on purpose: the packaged app loads this UI from file://
    // (Electron loadFile), where path-style URLs like /agents don't exist.
    // #/agents works identically under ng-serve and file://.
    provideRouter(routes, withHashLocation())
  ]
};
