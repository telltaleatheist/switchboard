import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ConfigService } from './core/config.service';
import { ConfirmDialog } from './shared/confirm-dialog/confirm-dialog';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ConfirmDialog],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly configService = inject(ConfigService);

  protected readonly devBaseUrl = signal('');
  protected readonly devToken = signal('');

  protected submitDevConfig(): void {
    this.configService.setDevConfig(this.devBaseUrl(), this.devToken());
  }

  protected retry(): void {
    void this.configService.load();
  }
}
