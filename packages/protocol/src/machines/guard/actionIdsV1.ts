/** Declaration-neutral vocabulary: Activity receipts reference Actions, not their schemas. */
export const MACHINE_GUARD_ACTIVITY_ACTION_IDS = ['machines.guard.activity.list', 'machines.guard.activity.undo'] as const;
export const MACHINE_GUARD_ACTION_IDS = [
  'machines.guard.get', ...MACHINE_GUARD_ACTIVITY_ACTION_IDS, 'machines.guard.idleStop.keepRunning', 'machines.guard.sessionCeiling.set',
] as const;
export type MachineGuardActionId = typeof MACHINE_GUARD_ACTION_IDS[number];
