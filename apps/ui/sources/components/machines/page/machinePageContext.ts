import * as React from 'react';

import type { useManagedEnrolledMachine } from '@/components/settings/machines/managed/ManagedMachineSections';

import type { MachinePageTarget } from './useMachinePageTarget';

/**
 * What the machine page reads once and its Overview shows: the resolved machine, its managed record
 * (when Happier created it), and the page's refresh. Tab bodies of other plans need only their props.
 */
export type MachinePageState = Readonly<{
    target: MachinePageTarget;
    managedEnrolled: ReturnType<typeof useManagedEnrolledMachine>;
    /** Bumped by the page's refresh; sections that load their own data reload when it changes. */
    refreshKey: number;
    /** Reloads what the Overview shows (the unavailable banner's Retry and pull-to-refresh). */
    reload(): Promise<void>;
}>;

export const MachinePageStateContext = React.createContext<MachinePageState | null>(null);

export function useMachinePageState(): MachinePageState {
    const state = React.useContext(MachinePageStateContext);
    if (!state) throw new Error('useMachinePageState must be used inside MachinePageScreen');
    return state;
}
