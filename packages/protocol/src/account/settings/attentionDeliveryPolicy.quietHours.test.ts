import { describe, expect, it } from 'vitest';

import { parseAccountSettings, resolveAttentionDecision } from './attentionDeliveryPolicy.testkit.js';
import { readNextAttentionQuietHoursBoundaryMs } from './attentionDeliveryPolicyDecision.js';

describe('attentionDeliveryPolicyV1 quiet hours', () => {
  it.each([
    { timezone: 'UTC', start: '09:00', end: '17:00', now: '2026-10-19T08:00:00Z', next: '2026-10-19T09:00:00Z' },
    { timezone: 'UTC', start: '09:00', end: '17:00', now: '2026-10-19T09:00:00Z', next: '2026-10-19T17:00:00Z' },
    { timezone: 'UTC', start: '22:00', end: '07:00', days: ['mon'], now: '2026-10-20T06:59:30Z', next: '2026-10-20T07:00:00Z' },
    { timezone: 'UTC', start: '22:00', end: '07:00', days: ['mon'], now: '2026-10-20T07:00:00Z', next: '2026-10-26T22:00:00Z' },
    // Spring's skipped local hour: the active window ends at the clock jump itself.
    { timezone: 'Europe/Amsterdam', start: '01:30', end: '02:30', now: '2026-03-29T00:45:00Z', next: '2026-03-29T01:00:00Z' },
    // Fall's repeated hour: the second start is observable even after the first end.
    { timezone: 'Europe/Amsterdam', start: '02:30', end: '02:45', now: '2026-10-25T00:50:00Z', next: '2026-10-25T01:30:00Z' },
    // A one-minute weekly window skipped by DST must still wake the following week.
    { timezone: 'Europe/Amsterdam', start: '02:30', end: '02:31', days: ['sun'], now: '2026-03-29T00:50:00Z', next: '2026-04-05T00:30:00Z' },
  ])('finds the exact next quiet-state transition: $timezone $now', ({ timezone, start, end, days, now, next }) => {
    const policy = parseAccountSettings({ attentionDeliveryPolicyV1: { quietHours: {
      enabled: true, timezone, windows: [{ startLocalTime: start, endLocalTime: end, days }],
    } } }).attentionDeliveryPolicyV1;
    const boundaryMs = readNextAttentionQuietHoursBoundaryMs(policy, new Date(now));
    expect(boundaryMs).toBe(Date.parse(next));
    const decision = (at: number) => resolveAttentionDecision({ policy, event: 'ready', channel: 'local_notification', now: new Date(at) });
    expect(decision(boundaryMs! - 1).channelMetadata.quietHoursActive)
      .not.toBe(decision(boundaryMs!).channelMetadata.quietHoursActive);
  });

  it('skips overlapping window edges and detects an always-active or empty schedule', () => {
    const policy = (windows: unknown, timezone = 'UTC') => parseAccountSettings({ attentionDeliveryPolicyV1: {
      quietHours: { enabled: true, timezone, windows },
    } }).attentionDeliveryPolicyV1;
    const now = new Date('2026-10-19T10:00:00Z');
    expect(readNextAttentionQuietHoursBoundaryMs(policy([
      { startLocalTime: '09:00', endLocalTime: '12:00' },
      { startLocalTime: '11:00', endLocalTime: '17:00' },
    ]), now)).toBe(Date.parse('2026-10-19T17:00:00Z'));
    expect(readNextAttentionQuietHoursBoundaryMs(policy([
      { startLocalTime: '00:00', endLocalTime: '12:00' },
      { startLocalTime: '12:00', endLocalTime: '00:00' },
    ]), now)).toBeNull();
    expect(readNextAttentionQuietHoursBoundaryMs(policy([{ startLocalTime: '09:00', endLocalTime: '09:00' }]), now)).toBeNull();
    expect(readNextAttentionQuietHoursBoundaryMs(policy([{ startLocalTime: '09:00', endLocalTime: '17:00' }], 'Not/AZone'), now)).toBeNull();
  });

  it('applies same-day quiet hours to interruptive notification channels', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'quiet_hours',
    });
  });

  it('applies midnight-wrapping quiet hours across local days', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '22:00', endLocalTime: '07:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: new Date('2026-05-03T23:30:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: new Date('2026-05-04T06:30:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });
  });

  it('applies an overnight window to the day on which the window starts', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '22:00', endLocalTime: '07:00', days: ['mon'] }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: new Date('2026-05-04T23:30:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: new Date('2026-05-05T06:30:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: new Date('2026-05-05T23:30:00.000Z'),
    })).toMatchObject({ delivery: 'deliver', reason: 'deliver' });
  });

  it('treats equal quiet-hour start and end times as a no-op window', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '09:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T09:00:00.000Z'),
    })).toMatchObject({ delivery: 'deliver', reason: 'deliver' });
  });

  it('treats invalid quiet-hour timezones as inactive instead of throwing', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'Not/AZone',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({ delivery: 'deliver', reason: 'deliver' });
  });

  it('uses the current device timezone for quiet-hour decisions when provided', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '10:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T07:30:00.000Z'),
      currentTimezone: 'Europe/Zurich',
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });
  });

  it('does not suppress webhooks during quiet hours unless explicitly configured', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'webhook',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({ delivery: 'deliver', reason: 'deliver' });
  });

  it('suppresses webhooks during quiet hours when the channel opts in', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
        channels: {
          webhook: {
            quietHoursBehavior: 'suppress',
          },
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'webhook',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });
  });

  it('removes sound from silent quiet-hour delivery decisions', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
        channels: {
          local_notification: {
            quietHoursBehavior: 'silent',
          },
        },
        sounds: {
          defaultSoundId: 'default',
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({
      delivery: 'silent',
      reason: 'quiet_hours',
      sound: { kind: 'none', volume: 1 },
    });
  });
});
