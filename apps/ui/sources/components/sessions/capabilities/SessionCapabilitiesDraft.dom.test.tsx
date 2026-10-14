/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const viewport = vi.hoisted(() => ({ width: 1440 }));
const transport = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => ({
  ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
  useWindowDimensions: () => ({ width: viewport.width, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { SessionAuthoringCapabilitiesField } = await import('@/components/sessions/authoring/controls/SessionAuthoringCapabilitiesField');
const { PopoverPortalTargetProvider } = await import('@/components/ui/popover/PopoverPortalTargetProvider');
const { createRequire } = getVitestNodeBuiltin<{ createRequire: (filename: string | URL) => (id: string) => unknown }>('node:module');
const { Drawer } = createRequire(import.meta.url)('vaul') as typeof import('vaul');
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => homes.reset());

it.each([390, 1440])('opens the production draft capability sheet inside the /new modal at %s without nested updates', async width => {
  viewport.width = width;
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Draft Home', serverUrl: 'https://draft-capabilities.test', accountId: 'owner' });
  homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
  transport.mockReset();
  transport.mockResolvedValue({ ok: true, machinePlatform: 'posix',
    mcp: { strictMode: false, items: [], detected: [] },
    skills: { items: [], plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
    applyTiming: { mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' } } });
  const container = document.createElement('div');
  document.body.append(container);
  const errors: unknown[] = [];
  const root = createRoot(container, { onUncaughtError: error => errors.push(error) });
  function Draft() {
    const [value, onChange] = React.useState<SessionCapabilitySelectionV1 | null>(null);
    const anchor = React.useRef(null);
    return <SessionAuthoringCapabilitiesField agentId="codex" context={{ machineId: 'machine', directory: '/repo', serverId, machineName: 'MacBook' }}
      value={value} onChange={onChange} testID="draft-capabilities" chipRenderContext={{ chipStyle: () => ({}),
        showLabel: true, iconColor: 'black', textStyle: {}, countTextStyle: {}, popoverAnchorRef: anchor }} />;
  }
  try {
    await act(async () => root.render(<Drawer.Root open handleOnly><Drawer.Portal><Drawer.Content>
      <Drawer.Title>New session</Drawer.Title><Drawer.Description>Configure a session</Drawer.Description>
      <PopoverPortalTargetProvider><Draft /></PopoverPortalTargetProvider>
    </Drawer.Content></Drawer.Portal></Drawer.Root>));
    const opener = document.querySelector<HTMLElement>('[data-testid="session-capabilities-chip"]');
    expect(opener).not.toBeNull();
    await act(async () => { opener!.focus(); opener!.click(); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(errors).toEqual([]);
      expect(document.querySelector('[data-testid="session-capabilities"]')).not.toBeNull();
      expect(transport).toHaveBeenCalled();
    });
    // Equal platform measurement publications must settle while the detail read completes.
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(errors).toEqual([]);
    expect(document.querySelector('[data-testid="session-capabilities"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
