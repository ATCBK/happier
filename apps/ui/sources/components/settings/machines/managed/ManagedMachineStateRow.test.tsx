import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const routerBoundary = createExpoRouterMock();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  router: async () => routerBoundary.module,
  storage: 'real',
});
afterEach(() => standardCleanup());

describe('managed lifecycle presentation', () => {
  it('keeps confirmed-absent recovery enabled inside a noninteractive historical resource row', async () => {
    const { ManagedCreationProgress } = await import('./ManagedCreationProgress');
    const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
    const machine = ManagedMachineV1Schema.parse({ id: 'ended-resource', homeId: 'home', custodianAccountId: 'owner',
      launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Ended resource', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'confirmed-absent', creationState: 'active',
      desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const remove = vi.fn();
    const screen = await renderScreen(<ManagedCreationProgress machine={machine} handlers={{ remove }} />);
    const action = screen.tree.findAll(node => typeof node.type === 'string'
      && node.props.testID === 'managed-machine.progress:remove');
    expect(action).toHaveLength(1);
    // aria-disabled on any emitted ancestor disables the descendant too, even when the button itself is enabled.
    for (let node: ReactTestInstance | null = action[0] ?? null; node; node = node.parent) {
      if (typeof node.type !== 'string') continue;
      expect(node.props['aria-disabled']).not.toBe(true);
      expect(node.props.accessibilityState?.disabled).not.toBe(true);
    }
    const row = screen.tree.findAll(node => typeof node.type === 'string'
      && node.props.testID === 'managed-machine.progress');
    expect(row).toHaveLength(1);
    expect(row[0]!.props.onPress).toBeUndefined();
    expect(row[0]!.props.role).not.toBe('button');
    expect(remove).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('managed-machine.progress:remove');
    expect(remove).toHaveBeenCalledOnce();
  });
  it('never words an accepted or unknown outcome as done', async () => {
    const { describeManagedLifecycleState } =
      await import('./managedLifecyclePresentation');
    const pending = describeManagedLifecycleState({ kind: 'stopPending' });
    expect(pending.tone).toBe('pending');
    expect(pending.line).toBe(
      'Stop requested. Stopping hasn’t been confirmed.',
    );
    const cleanup = describeManagedLifecycleState({
      kind: 'cleanupPending',
      reason: 'Hetzner returned 503.',
    });
    expect(cleanup.tone).toBe('danger');
    expect(cleanup.line).toContain('Provider charges may continue');
    expect(cleanup.line).not.toMatch(/\bdeleted\b/i);
    const missing = describeManagedLifecycleState({
      kind: 'localMissing',
      controller: 'MacBook Pro',
    });
    expect(missing.line).toContain('Confirm it’s gone');
    expect(missing.actions).toEqual(['checkNow']);
  });

  it.each(['cleanupPending', 'cleanupUnknown', 'creationCanceledCleanup'] as const)('offers console recovery only when its owner supplies a handler (%s)', async kind => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const pressed: string[] = [];
    const screen = await renderScreen(
      <ManagedMachineStateRow
        testID="row"
        name="hz-build-0"
        mark={null}
        provider="Hetzner"
        state={{ kind }}
        handlers={{}}
      />,
    );
    expect(screen.findByTestId('row:openProvider')).toBeNull();
    await screen.update(<ManagedMachineStateRow testID="row" name="hz-build-0" mark={null}
      provider="Hetzner" state={{ kind }} handlers={{ openProvider: () => pressed.push('openProvider') }} />);
    await act(async () => {
      screen.pressByTestId('row:openProvider');
    });
    expect(pressed).toEqual(['openProvider']);
  });

  it('speaks a deletion that was not confirmed as the page banner, with Try again before the way out', async () => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const { t } = await import('@/text');
    const pressed: string[] = [];
    const screen = await renderScreen(
      <ManagedMachineStateRow testID="row" name="hz-build-0" mark={null} provider="Hetzner"
        state={{ kind: 'cleanupPending', reason: 'Hetzner returned 503.' }}
        handlers={{ openProvider: () => pressed.push('openProvider'), tryAgain: () => pressed.push('tryAgain') }} />,
    );
    // A banner, titled with the state rather than the resource's name.
    expect(screen.findByTestId('row')).not.toBeNull();
    expect(screen.tree.findAll((node) => node.props.children === t('managedCleanup.pendingTitle')).length).toBeGreaterThan(0);
    expect(screen.tree.findAll((node) => node.props.children === 'hz-build-0')).toHaveLength(0);
    await act(async () => { screen.pressByTestId('row:tryAgain'); });
    await act(async () => { screen.pressByTestId('row:openProvider'); });
    expect(pressed).toEqual(['tryAgain', 'openProvider']);
  });

  it('waits for an offline controller in a banner that can cancel the creation', async () => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const { t } = await import('@/text');
    const pressed: string[] = [];
    const screen = await renderScreen(
      <ManagedMachineStateRow testID="row" name="hz-build-3" mark={null} provider="Hetzner"
        state={{ kind: 'controllerWaiting', name: 'hz-build-3', controller: 'MacBook Pro', provider: 'Hetzner' }}
        handlers={{ cancel: () => pressed.push('cancel') }} />,
    );
    expect(screen.tree.findAll((node) => node.props.children === t('managedMachines.controller.waiting', { controller: 'MacBook Pro' })).length)
      .toBeGreaterThan(0);
    await act(async () => { screen.pressByTestId('row:cancel'); });
    expect(pressed).toEqual(['cancel']);
  });

  it('tints only the cause of a per-resource fact, never the next step', async () => {
    const { ManagedMachineStateRow } = await import('./ManagedMachineStateRow');
    const { t } = await import('@/text');
    const screen = await renderScreen(
      <ManagedMachineStateRow testID="row" name="mac-vm-0" mark={null}
        state={{ kind: 'localMissing', controller: 'MacBook Pro' }} handlers={{}} />,
    );
    const cause = t('managedMachines.local.missingCause', { controller: 'MacBook Pro' });
    const causeNodes = screen.tree.findAll((node) => node.props.children === cause);
    expect(causeNodes.length).toBeGreaterThan(0);
    // The whole sentence pair is never one tinted string.
    expect(screen.tree.findAll((node) => node.props.children === `${cause} ${t('managedMachines.local.missingDetail')}`)).toHaveLength(0);
  });

  it('opens the Account default that turned creating machines off', async () => {
    const { ManagedCreationDisabledBanner } = await import('./ManagedMachineStateRow');
    routerBoundary.spies.push.mockClear();
    const screen = await renderScreen(<ManagedCreationDisabledBanner testID="off" />);
    await act(async () => { screen.pressByTestId('off:change'); });
    expect(routerBoundary.spies.push).toHaveBeenCalledWith('/settings/machines/defaults');
  });
});
