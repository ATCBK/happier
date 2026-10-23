/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';

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
  observeMachinePresenceForTest(scope, [machine.id]);
  const snapshot = storage.getState();
  expect(resolveVoiceExecutionMachineIdFromState(snapshot)).toBe(machine.id);
  const deadline = machine.activeAt + readMachineOnlineGraceMsFromEnv();
  let now = deadline - 1;
  const voice = voiceSettingsParse({ providerId: 'local_conversation' });
  // React's initial subscription may legitimately re-read selection. Move the
  // clock at the render boundary, not based on an internal function's stack.
  vi.spyOn(Date, 'now').mockImplementation(() => now);
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
  now = deadline + 1;
  await hook.rerender();
  if (consumer === 'execution') expect(hook.getCurrent()).toBeNull();
  else expect(hook.getCurrent()).not.toBe(first);
  expect(storage.getState()).toBe(snapshot);
});
