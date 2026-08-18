import { Injectable, signal } from '@angular/core';

/** A question currently on screen; null when no dialog is open. */
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

/**
 * Promise-based replacement for window.confirm(): callers await ask() and get
 * a boolean; the ConfirmDialog component (mounted once in the app root) renders
 * whatever question is pending. Only one question can be open at a time — a
 * second ask() while one is pending settles the first as cancelled, since the
 * user never answered it.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly request = signal<ConfirmRequest | null>(null);
  private resolvePending: ((answer: boolean) => void) | null = null;

  ask(opts: ConfirmOptions): Promise<boolean> {
    this.answer(false);
    return new Promise<boolean>((resolve) => {
      this.resolvePending = resolve;
      this.request.set({
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel ?? 'Confirm',
        cancelLabel: opts.cancelLabel ?? 'Cancel',
        danger: opts.danger ?? false,
      });
    });
  }

  answer(value: boolean): void {
    const resolve = this.resolvePending;
    this.resolvePending = null;
    this.request.set(null);
    resolve?.(value);
  }
}
