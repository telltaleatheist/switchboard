import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import type { ArchiveDetail, ArchiveSummary } from '../../core/api.models';
import { startPolling } from '../../core/polling';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';

@Component({
  selector: 'app-archives-page',
  imports: [FormsModule, RelativeTimePipe],
  templateUrl: './archives.page.html',
  styleUrl: './archives.page.css',
})
export class ArchivesPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);

  protected readonly archives = signal<ArchiveSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly selectedId = signal<number | null>(null);
  protected readonly selected = signal<ArchiveDetail | null>(null);
  protected readonly selectedLoading = signal(false);
  protected readonly selectedError = signal<string | null>(null);

  protected readonly purgeDays = signal(30);
  protected readonly purging = signal(false);
  protected readonly purgeResult = signal<number | null>(null);
  protected readonly purgeError = signal<string | null>(null);

  private stopPolling?: () => void;

  ngOnInit(): void {
    void this.refresh();
    this.stopPolling = startPolling(() => void this.refresh());
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
  }

  protected async refresh(): Promise<void> {
    try {
      const { archives } = await this.api.listArchives();
      this.archives.set(archives);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Failed to load archives.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async select(id: number): Promise<void> {
    this.selectedId.set(id);
    this.selected.set(null);
    this.selectedError.set(null);
    this.selectedLoading.set(true);
    try {
      this.selected.set(await this.api.getArchive(id));
    } catch (err) {
      this.selectedError.set(err instanceof ApiError ? err.message : `Failed to load archive #${id}.`);
    } finally {
      this.selectedLoading.set(false);
    }
  }

  protected exportMarkdown(): void {
    const archive = this.selected();
    if (!archive) return;
    const blob = new Blob([archive.transcript], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${archive.channel_name}-${archive.id}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  protected async purge(): Promise<void> {
    const days = this.purgeDays();
    if (!Number.isFinite(days) || days < 0) return;
    if (
      !confirm(
        `Permanently delete archives (and their messages) for channels closed more than ${days} day(s) ago? This cannot be undone.`,
      )
    ) {
      return;
    }
    this.purging.set(true);
    this.purgeError.set(null);
    this.purgeResult.set(null);
    try {
      const { deleted } = await this.api.purge(days);
      this.purgeResult.set(deleted);
      await this.refresh();
      if (this.selectedId() !== null && !this.archives().some((a) => a.id === this.selectedId())) {
        this.selectedId.set(null);
        this.selected.set(null);
      }
    } catch (err) {
      this.purgeError.set(err instanceof ApiError ? err.message : 'Purge failed.');
    } finally {
      this.purging.set(false);
    }
  }
}
