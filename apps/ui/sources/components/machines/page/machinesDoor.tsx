import * as React from 'react';

/**
 * The two doors of the one Machines page (R1): the rail Machines icon (`/machines/**`, the machine list
 * as the shell column, no Settings column) and Settings → Machines (`/settings/machines/**`, the same
 * list beside the Settings column). Everything rendered inside a door builds its links for that door.
 */
export type MachinesDoor = 'rail' | 'settings';

const MachinesDoorContext = React.createContext<MachinesDoor>('settings');

/** Set once by each door's layout; every page, list and row below reads it. */
export function MachinesDoorProvider(props: Readonly<{ door: MachinesDoor; children: React.ReactNode }>) {
    return <MachinesDoorContext.Provider value={props.door}>{props.children}</MachinesDoorContext.Provider>;
}

/** The door the current Machines page was opened through (Settings when nothing set one). */
export function useMachinesDoor(): MachinesDoor {
    return React.useContext(MachinesDoorContext);
}
