import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { ConfirmService } from '../../core/confirm.service';

/**
 * The one card every yes/no question in this app is asked in — no native
 * window.confirm() anywhere (operator's rule: zero JS alerts, custom modals
 * only). Mounted once in the app root; renders whatever question
 * ConfirmService has pending.
 *
 * Safety follows the creamsicle dialog convention: focus lands on Cancel (a
 * reflexive Enter must never destroy anything), Escape and the scrim answer
 * "no", and the destructive button sits last so Tab reaches it deliberately.
 */
@Component({
  selector: 'app-confirm-dialog',
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.css',
})
export class ConfirmDialog {
  protected readonly confirm = inject(ConfirmService);

  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelBtn');

  constructor() {
    // Focus the safe answer the moment the card appears. Done in an effect
    // because the card is created by a control-flow block — there's no page
    // load for an autofocus attribute to be honored at, and a card that opens
    // without focus sends Escape/Enter to whatever is behind the scrim.
    effect(() => {
      if (this.confirm.request() === null) return;
      queueMicrotask(() => this.cancelButton()?.nativeElement.focus());
    });
  }
}
