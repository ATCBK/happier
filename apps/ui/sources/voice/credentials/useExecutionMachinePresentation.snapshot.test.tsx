/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
const { activateStorageAccountScope } = await import('@/dev/testkit/mocks/storage');
const { storage } = await import('@/sync/domains/state/storage');
const { readMachineOnlineGraceMsFromEnv } = await import('@/utils/sessions/machineUtils');
const { resolveVoiceExecutionMachineIdFromState } = await import('@/voice/settings/executionMachine');
const { useVoiceExecutionMachineId } = await import('./useExecutionMachinePresentation');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { useBundledConversationProviderSettings } = await import('@/voice/settings/panels/realtime/useBundledConversationProviderSettings');

const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof activateStorageAccountScope>> | undefined;
afterEach(async () => {
  await standardCleanup();
  vi.restoreAllMocks();
  account?.dispose();
  account = undefined;
  storage.setState(initialStorage, true);
});

it.each(['execution', 'catalog'] as const)('keeps the %s snapshot stable across presence expiry and refreshes it on the next render', async consumer => {
  const scope = { serverId: 'voice-snapshot-home', accountId: 'voice-snapshot-account' };
  account = await activateStorageAccountScope(scope);
  const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() });
  storage.setState(state => ({
    settingsScope: scope,
    settings: { ...state.settings, voice: { ...state.settings.voice,
      executionMachine: { mode: 'fixed', machineId: machine.id },
    } },
    machines: { [machine.id]: machine },
    machineListByServerId: { [scope.serverId]: [machine] },
    machineListStatusByServerId: { [scope.serverId]: 'idle' },
  }));
  const snapshot = storage.getState();
  expect(resolveVoiceExecutionMachineIdFromState(snapshot)).toBe(machine.id);
  const deadline = machine.activeAt + readMachineOnlineGraceMsFromEnv();
  let now = deadline - 1;
  const voice = voiceSettingsParse({ providerId: 'local_conversation' });
  // Advance the genuine clock boundary across the existing presence deadline
  // at the first machine-selection read, not at React scheduler clock reads.
  vi.spyOn(Date, 'now').mockImplementation(() => {
    const current = now;
    if (new Error().stack?.includes('resolveReplacementAwareSelection')) now = deadline + 1;
    return current;
  });
  const consoleErrors = vi.spyOn(console, 'error');
  const hook = await renderHook(() => {
    return consumer === 'execution' ? useVoiceExecutionMachineId()
      : useBundledConversationProviderSettings(voice).sessionChoice?.targetKey ?? null;
  });
  expect(storage.getState()).toBe(snapshot);
  expect(consoleErrors.mock.calls.filter(([message]) => (
    typeof message === 'string' && /getSnapshot|Maximum update depth exceeded/.test(message)
  ))).toEqual([]);
  const first = hook.getCurrent();
  if (consumer === 'execution') expect(first).toBe(machine.id);
  else expect(first).toEqual(expect.any(String));
  await hook.rerender();
  if (consumer === 'execution') expect(hook.getCurrent()).toBeNull();
  else expect(hook.getCurrent()).not.toBe(first);
  expect(storage.getState()).toBe(snapshot);
});
