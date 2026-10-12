import { describe, expect, it } from 'vitest';
import { describeSessionStopMarker } from './sessionStopMarker';

describe('current Session stop marker', () => {
  const requested = { v: 1, at: 1000, rule: 'idle_sessions', status: 'requested', idleMs: 7200000, freedBytes: 1024 } as const;
  const event = { type: 'message', sessionStopV1: requested };
  it('does not claim stopped or freed memory from intent', () => {
    const text = describeSessionStopMarker(event, () => '13:40')?.text;
    expect(text).toContain('Stop requested');
    expect(text).not.toContain('freed');
  });
  it.each(['cancelled', 'failed', 'stopped'] as const)('renders current %s settlement at the same address', status => {
    const marker = describeSessionStopMarker(event, () => '13:40', { ...requested, status, settledAt: 2000 });
    expect(marker?.text).toContain(status === 'cancelled' ? 'Stop cancelled' : status === 'failed' ? 'Could not stop' : 'Stopped after');
    expect(marker?.text.includes('freed')).toBe(status === 'stopped');
  });
});
