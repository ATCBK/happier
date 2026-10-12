import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { Modal } from '@/modal';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

/**
 * The configurator outlives the picker that opened it (lab m-pick): the host closes first, then the
 * configurator opens as its own modal and stays open when the picker's content unmounts.
 * The modal provider is the overlay host boundary; it is replaced with a recording one.
 */
function recordModalHost() {
  const events: string[] = [];
  const shown: Array<Readonly<{ id: string; props: Record<string, unknown> }>> =
    [];
  Modal.setFunctions(
    (config) => {
      const id = `modal-${shown.length + 1}`;
      events.push(`show:${id}`);
      shown.push({
        id,
        props: (config as { props?: Record<string, unknown> }).props ?? {},
      });
      return id;
    },
    (id) => {
      events.push(`hide:${id}`);
    },
    () => {
      events.push('hideAll');
    },
  );
  return { events, shown };
}

function binding(current = true): ServerCredentialAccountScopeBinding {
  return {
    accountId: 'account-a',
    serverId: 'server-a',
    revision: 1,
    isCurrent: () => current,
    onRetire: () => Object.freeze({ dispose(): void {} }),
  } as unknown as ServerCredentialAccountScopeBinding;
}

describe('useManagedMachineConfigurator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the picker first, then opens the configurator, which survives the picker unmounting', async () => {
    const host = recordModalHost();
    const { useManagedMachineConfigurator } =
      await import('./ManagedMachineSelectionOffers');
    const onConfigure = vi.fn(() => {
      host.events.push('picker:close');
    });
    const onUse = vi.fn();
    const accountBinding = binding();
    const hook = await renderHook(() =>
      useManagedMachineConfigurator({
        serverId: 'server-a',
        binding: accountBinding,
        onUse,
        onConfigure,
      }),
    );

    hook.getCurrent()(null);
    await hook.unmount();

    expect(host.events).toEqual(['picker:close', 'show:modal-1']);
    // The opener's binding dies with the picker (its isCurrent() follows the picker's mount), so the
    // modal takes the Account to keep, not the binding: a stale binding closed it in a loop live.
    expect(host.shown[0]?.props.binding).toBeUndefined();
    expect(host.shown[0]?.props.accountId).toBe(accountBinding.accountId);
    expect(host.shown[0]?.props.preset).toBeNull();
  });

  it('opens nothing and leaves the picker alone for an Account that is no longer current', async () => {
    const host = recordModalHost();
    const { useManagedMachineConfigurator } =
      await import('./ManagedMachineSelectionOffers');
    const onConfigure = vi.fn();
    const hook = await renderHook(() =>
      useManagedMachineConfigurator({
        serverId: 'server-a',
        binding: binding(false),
        onUse: vi.fn(),
        onConfigure,
      }),
    );

    hook.getCurrent()(null);

    expect(onConfigure).not.toHaveBeenCalled();
    expect(host.events).toEqual([]);
    await hook.unmount();
  });
});
