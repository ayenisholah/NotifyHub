import { describe, expect, it } from 'vitest';

import {
  InvalidQuietHoursError,
  resolveQuietHours,
  type QuietHoursInput,
} from '../packages/core/src/index.js';

const utcWindow = (iso: string, startMinute = 9 * 60, endMinute = 17 * 60): QuietHoursInput => ({
  now: new Date(iso),
  timezone: 'UTC',
  startMinute,
  endMinute,
});

describe('quiet-hours resolution', () => {
  it.each([
    ['before', '2026-07-12T08:59:00Z', false],
    ['at start', '2026-07-12T09:00:00Z', true],
    ['inside', '2026-07-12T12:00:00Z', true],
    ['at end', '2026-07-12T17:00:00Z', false],
    ['after', '2026-07-12T17:01:00Z', false],
  ])('handles a same-day window %s', (_label, iso, active) => {
    const result = resolveQuietHours(utcWindow(iso));
    expect(result.active).toBe(active);
    if (active) expect(result.scheduledFor).toEqual(new Date('2026-07-12T17:00:00Z'));
  });

  it.each([
    ['before start', '2026-07-12T21:59:00Z', false, null],
    ['late portion', '2026-07-12T23:00:00Z', true, '2026-07-13T08:00:00Z'],
    ['early portion', '2026-07-13T03:00:00Z', true, '2026-07-13T08:00:00Z'],
    ['at end', '2026-07-13T08:00:00Z', false, null],
  ])('handles a midnight-crossing window %s', (_label, iso, active, scheduledFor) => {
    expect(resolveQuietHours(utcWindow(iso, 22 * 60, 8 * 60))).toEqual({
      active,
      scheduledFor: scheduledFor === null ? null : new Date(scheduledFor),
    });
  });

  it('calculates the UTC end from the user timezone', () => {
    expect(
      resolveQuietHours({
        now: new Date('2026-07-12T22:30:00Z'),
        timezone: 'Africa/Lagos',
        startMinute: 22 * 60,
        endMinute: 8 * 60,
      }),
    ).toEqual({ active: true, scheduledFor: new Date('2026-07-13T07:00:00Z') });
  });

  it('treats equal boundaries as inactive', () => {
    expect(resolveQuietHours(utcWindow('2026-07-12T09:00:00Z', 60, 60))).toEqual({
      active: false,
      scheduledFor: null,
    });
  });

  it.each([
    [{ ...utcWindow('2026-07-12T09:00:00Z'), timezone: 'Not/AZone' }, 'timezone'],
    [{ ...utcWindow('2026-07-12T09:00:00Z'), startMinute: -1 }, 'startMinute'],
    [{ ...utcWindow('2026-07-12T09:00:00Z'), endMinute: 1440 }, 'endMinute'],
  ])('rejects invalid input', (input, message) => {
    expect(() => resolveQuietHours(input)).toThrowError(InvalidQuietHoursError);
    expect(() => resolveQuietHours(input)).toThrow(message);
  });
});
