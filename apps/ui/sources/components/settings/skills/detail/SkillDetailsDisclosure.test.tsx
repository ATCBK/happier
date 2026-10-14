import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The person's answers are the boundary (the shared modal presenter), as in the detail screen's tests.
const modalSpies = vi.hoisted(() => ({ confirm: vi.fn(async () => true), alert: vi.fn() }));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: modalSpies }).module;
});
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

const { SkillDetailsDisclosure } = await import('./SkillDetailsDisclosure');

afterEach(() => {
  standardCleanup();
  modalSpies.confirm.mockReset();
  modalSpies.confirm.mockResolvedValue(true);
  modalSpies.alert.mockReset();
});

const machine = { machineId: 'm1', name: 'NLDW6' };
type Call = Readonly<{ actionId: string; input: unknown }>;

async function open(
  execute: React.ComponentProps<typeof SkillDetailsDisclosure>['execute'],
  installedPaths?: Record<string, readonly string[]>,
) {
  const screen = await renderScreen(
    <SkillDetailsDisclosure
      testID="d"
      skillId="s1"
      revision="r1"
      onlineMachines={[machine]}
      allowInstall
      installedPaths={installedPaths}
      execute={execute}
    />,
  );
  await act(async () => screen.pressByTestId('d:header'));
  return screen;
}

describe('Also install on a machine', () => {
  it('shows where the copies Happier wrote are, from the last scan, before anything is pressed', async () => {
    const screen = await open(vi.fn(), { m1: ['/home/u/.claude/skills/s1', '/home/u/.codex/skills/s1'] });
    expect(screen.getTextContent()).toContain('Installed in /home/u/.claude/skills/s1');
    expect(screen.getTextContent()).toContain('Installed in /home/u/.codex/skills/s1');
  });

  it('shows the receipts it just wrote, and removing asks first and then takes them away', async () => {
    const calls: Call[] = [];
    const execute = vi.fn(async (actionId: string, input: unknown) => {
      calls.push({ actionId, input });
      return actionId === 'skills.machine.install'
        ? { ok: true as const, result: { receipts: [{ root: '/r', path: '/r/s1', digest: 'd' }] } }
        : { ok: true as const, result: { removed: ['/r/s1'] } };
    });
    const screen = await open(execute as never);
    await act(async () => { await screen.pressByTestIdAsync('d:toggle:m1'); });
    expect(screen.getTextContent()).toContain('Installed in /r/s1');
    await act(async () => { await screen.pressByTestIdAsync('d:toggle:m1'); });
    expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.actionId)).toEqual(['skills.machine.install', 'skills.machine.uninstall']);
    expect(screen.getTextContent()).not.toContain('Installed in');
  });

  it('declining the removal removes nothing', async () => {
    modalSpies.confirm.mockResolvedValue(false);
    const execute = vi.fn();
    const screen = await open(execute as never, { m1: ['/r/s1'] });
    await act(async () => { await screen.pressByTestIdAsync('d:toggle:m1'); });
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getTextContent()).toContain('Installed in /r/s1');
  });

  it('never deletes a copy edited outside Happier silently: it says so and asks again before forcing', async () => {
    const calls: Call[] = [];
    const execute = vi.fn(async (actionId: string, input: unknown) => {
      calls.push({ actionId, input });
      return (input as { force?: boolean }).force
        ? { ok: true as const, result: { removed: ['/r/s1'] } }
        : { ok: false as const, errorCode: 'externally_modified', error: 'externally_modified' };
    });
    const screen = await open(execute as never, { m1: ['/r/s1'] });
    await act(async () => { await screen.pressByTestIdAsync('d:toggle:m1'); });
    expect(modalSpies.confirm).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => (call.input as { force?: boolean }).force ?? false)).toEqual([false, true]);
    expect(screen.getTextContent()).not.toContain('Installed in');
  });

  it('keeps the copies a partial install did write, and explains a native name clash', async () => {
    const execute = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'native_conflict',
      error: 'native_conflict',
      details: { receipts: [{ root: '/r', path: '/r/s1', digest: 'd' }] },
    }));
    const screen = await open(execute as never);
    await act(async () => { await screen.pressByTestIdAsync('d:toggle:m1'); });
    expect(screen.getTextContent()).toContain('Installed in /r/s1');
    expect(modalSpies.alert).toHaveBeenCalledTimes(1);
    expect(String(modalSpies.alert.mock.calls[0]?.[1])).toContain('already has a different skill');
  });
});
