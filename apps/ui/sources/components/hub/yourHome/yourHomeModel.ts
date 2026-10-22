/**
 * What the "Your Home" widget shows (atmosphere lab `at-widget.js`): the Home's machines as moons,
 * each with the sessions riding its orbit. A session either needs the person, is working, or idles;
 * an offline machine shows none of its sessions and is counted only as a machine.
 */
export type YourHomeSessionState = 'need' | 'work' | 'idle';

export type YourHomeMachineInput = Readonly<{
  id: string;
  name: string;
  online: boolean | null;
  /** When an offline machine was last seen, for its "last seen" line. */
  lastSeenAt: number | null;
  isThisComputer: boolean;
  sessions: readonly YourHomeSessionState[];
}>;

export type YourHomeMachine = YourHomeMachineInput &
  Readonly<{
    /** The sessions drawn on its orbit: none while it is offline. */
    shown: readonly YourHomeSessionState[];
    needsYou: number;
    working: number;
  }>;

export type YourHomeModel = Readonly<{
  machines: readonly YourHomeMachine[];
  online: number;
  /** Sessions waiting on the person, on machines that are online. */
  needsYou: number;
  /** Sessions working right now, on machines that are online. */
  working: number;
}>;

/** The header's one fact: amber when anything needs the person, else how much is working. */
export type YourHomeHeaderFact = Readonly<{
  kind: 'needsYou' | 'working';
  count: number;
}>;

// Nearest the moon first: work, then what needs you, then what idles (lab MacBook Pro).
const ORDER: Readonly<Record<YourHomeSessionState, number>> = {
  work: 0,
  need: 1,
  idle: 2,
};

export function buildYourHomeModel(
  machines: readonly YourHomeMachineInput[],
): YourHomeModel {
  let needsYou = 0;
  let working = 0;
  const projected = machines.map((machine): YourHomeMachine => {
    const shown = machine.online
      ? [...machine.sessions].sort((a, b) => ORDER[a] - ORDER[b])
      : [];
    const need = shown.filter((state) => state === 'need').length;
    const work = shown.filter((state) => state === 'work').length;
    needsYou += need;
    working += work;
    return { ...machine, shown, needsYou: need, working: work };
  });
  // Inner orbits and the first legend rows go to what matters now: machines that need you, then
  // machines at work, then the other online ones, then offline ones; each group keeps the store's order.
  const rank = (machine: YourHomeMachine) =>
    !machine.online ? 3 : machine.needsYou > 0 ? 0 : machine.working > 0 ? 1 : 2;
  projected.sort((a, b) => rank(a) - rank(b));
  return {
    machines: projected,
    online: machines.filter((machine) => machine.online).length,
    needsYou,
    working,
  };
}

export function resolveYourHomeHeaderFact(
  model: YourHomeModel,
): YourHomeHeaderFact | null {
  if (model.machines.length === 0) return null;
  return model.needsYou > 0
    ? { kind: 'needsYou', count: model.needsYou }
    : { kind: 'working', count: model.working };
}
