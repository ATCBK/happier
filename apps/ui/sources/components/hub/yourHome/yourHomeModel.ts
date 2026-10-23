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

export const LEGEND_ROW_PX = 40;
export const LEGEND_ROW_COMPACT_PX = 30;
export const LEGEND_GAP_PX = 2;

/**
 * The machines the legend can name in `height` px, and how many it folds into its one "more" row (which
 * takes the last row of room). The orbit draws exactly the named machines: a moon the legend does not
 * name is an unlabelled bead, and a fleet of dozens would crowd the outer orbit into a necklace.
 */
export function fitYourHomeLegend(
  machines: readonly YourHomeMachine[],
  height: number,
  compact: boolean,
): Readonly<{ shown: readonly YourHomeMachine[]; more: number }> {
  const rowPx = compact ? LEGEND_ROW_COMPACT_PX : LEGEND_ROW_PX;
  const fits = Math.max(1, Math.floor((height + LEGEND_GAP_PX) / (rowPx + LEGEND_GAP_PX)));
  const shown = machines.length > fits ? machines.slice(0, fits - 1) : machines;
  return { shown, more: machines.length - shown.length };
}

export type YourHomeLayout = 'small' | 'medium' | 'wide' | 'full';

/** The lab's Small and Medium compositions are drawn for a card this wide (its A3 half column). */
const HALF_CARD_PX = 262;

/**
 * The composition for a saved size in the body width the frame measured. The side-by-side compositions
 * (wide, full) need room for the machines' names beside the scene: a card narrower than two half cards
 * (a phone) stacks them under it instead, so the suffix that tells same-named machines apart is never cut.
 * A half-width size that its row stretched across the card (alone in a group row) takes the side-by-side
 * composition rather than a lone planet in a band.
 */
export function resolveYourHomeLayout(size: string | undefined, width: number): YourHomeLayout {
  const roomy = width >= HALF_CARD_PX * 2;
  if (size === 'small') return roomy ? 'wide' : 'small';
  if (size === 'wide') return roomy ? 'wide' : 'medium';
  if (size === 'full' || size === 'large') return roomy ? 'full' : 'medium';
  return roomy ? 'full' : 'medium';
}
