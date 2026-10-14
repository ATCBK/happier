import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

import {
  sessionCapabilityApplyNotice,
  type SessionCapabilityApplyNotice,
} from './sessionCapabilityApplyNotice';
import { useSessionCapabilityRestart } from './sessionCapabilityRestart';

afterEach(() => standardCleanup());

/** A pending MCP change on a launch the runner cannot restart itself (D34), through the real notice producer. */
function restartNotice(turnSettled: boolean): SessionCapabilityApplyNotice {
  const notice = sessionCapabilityApplyNotice({
    pendingApply: { mcp: true, skills: false, restartBy: 'user' },
    applyTiming: {
      mcp: { t: 'restart_to_apply', restartBy: 'user' },
      skills: { t: 'next_turn' },
    },
    change: { kind: 'mcp_server', title: 'Linear', state: 'on' },
    machineOnline: true,
    machineName: 'win-box',
    turnSettled,
  });
  if (!notice) throw new Error('expected a restart notice');
  return notice;
}

describe('the D34 Restart on the one apply line', () => {
  it('is not an action while a turn runs or an approval waits', async () => {
    const stop = vi.fn(async () => true);
    const resume = vi.fn(async () => true);
    const hook = await renderHook(() =>
      useSessionCapabilityRestart({
        notice: restartNotice(false),
        stop,
        resume,
      }),
    );
    expect(hook.getCurrent().badge).toMatchObject({
      label: t('capabilities.session.apply.restart', {
        item: 'Linear',
        machine: 'win-box',
      }),
    });
    expect(hook.getCurrent().badge?.onPress).toBeUndefined();
    await act(async () => {
      await hook.getCurrent().restart();
    });
    expect(stop).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('stops, then resumes once, when the turn is settled', async () => {
    const order: string[] = [];
    let finishStop: (value: boolean) => void = () => {};
    const stop = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          order.push('stop');
          finishStop = resolve;
        }),
    );
    const resume = vi.fn(async () => {
      order.push('resume');
      return true;
    });
    const hook = await renderHook(() =>
      useSessionCapabilityRestart({
        notice: restartNotice(true),
        stop,
        resume,
      }),
    );
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = hook.getCurrent().restart();
    });
    // While it restarts the line says so and is not pressable a second time.
    expect(hook.getCurrent().badge).toMatchObject({
      label: t('capabilities.session.restart.restarting'),
    });
    expect(hook.getCurrent().badge?.onPress).toBeUndefined();
    await act(async () => {
      finishStop(true);
      await pending;
    });
    expect(order).toEqual(['stop', 'resume']);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().state).toBe('idle');
  });

  it('leaves the change saved after a failed stop and offers Try again', async () => {
    const stop = vi.fn(async () => false);
    const resume = vi.fn(async () => true);
    const hook = await renderHook(() =>
      useSessionCapabilityRestart({
        notice: restartNotice(true),
        stop,
        resume,
      }),
    );
    await act(async () => {
      await hook.getCurrent().restart();
    });
    expect(resume).not.toHaveBeenCalled();
    expect(hook.getCurrent().badge).toMatchObject({
      label: t('capabilities.session.restart.failed'),
      tone: 'warning',
    });
    expect(typeof hook.getCurrent().badge?.onPress).toBe('function');
    stop.mockResolvedValueOnce(true);
    await act(async () => {
      await hook.getCurrent().restart();
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().state).toBe('idle');
  });
});
