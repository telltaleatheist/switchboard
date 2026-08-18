import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import type { PatchRequest } from '../../core/api.models';
import { startPolling } from '../../core/polling';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';

@Component({
  selector: 'app-patch-requests-page',
  imports: [FormsModule, RelativeTimePipe],
  templateUrl: './patch-requests.page.html',
  styleUrl: './patch-requests.page.css',
})
export class PatchRequestsPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);

  protected readonly requests = signal<PatchRequest[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** channel-name override typed per pending request, keyed by request id */
  protected readonly channelNameDrafts = signal<Record<number, string>>({});
  protected readonly busyId = signal<number | null>(null);

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
      const { requests } = await this.api.listPendingPatchRequests();
      this.requests.set(requests);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Failed to load patch requests.');
    } finally {
      this.loading.set(false);
    }
  }

  protected draftFor(id: number): string {
    return this.channelNameDrafts()[id] ?? '';
  }

  protected setDraft(id: number, value: string): void {
    this.channelNameDrafts.update((drafts) => ({ ...drafts, [id]: value }));
  }

  protected async approve(request: PatchRequest): Promise<void> {
    this.busyId.set(request.id);
    try {
      const name = this.draftFor(request.id).trim();
      await this.api.approvePatchRequest(request.id, name || undefined);
      await this.refresh();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : `Failed to approve request #${request.id}.`);
    } finally {
      this.busyId.set(null);
    }
  }

  protected async deny(request: PatchRequest): Promise<void> {
    this.busyId.set(request.id);
    try {
      await this.api.denyPatchRequest(request.id);
      await this.refresh();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : `Failed to deny request #${request.id}.`);
    } finally {
      this.busyId.set(null);
    }
  }
}
