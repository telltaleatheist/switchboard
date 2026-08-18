import { Pipe, PipeTransform } from '@angular/core';

/** Renders an ISO-8601 timestamp (or a raw ms duration) as a short "3m ago" / "2d" string. */
@Pipe({ name: 'relativeTime', pure: false })
export class RelativeTimePipe implements PipeTransform {
  transform(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    const then = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isNaN(then)) return '—';
    const deltaMs = Date.now() - then;
    return formatDuration(deltaMs);
  }
}

export function formatDuration(deltaMs: number): string {
  const future = deltaMs < 0;
  const abs = Math.abs(deltaMs);
  const sec = Math.floor(abs / 1000);
  if (sec < 5) return future ? 'just now' : 'just now';
  if (sec < 60) return `${sec}s${future ? '' : ' ago'}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${future ? '' : ' ago'}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h${future ? '' : ' ago'}`;
  const day = Math.floor(hr / 24);
  return `${day}d${future ? '' : ' ago'}`;
}
