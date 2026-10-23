import { describe, expect, it } from 'vitest';

import {
  buildYourHomeModel,
  fitYourHomeLegend,
  resolveYourHomeLayout,
  resolveYourHomeHeaderFact,
  type YourHomeMachineInput,
} from './yourHomeModel';

const machine = (
  input: Partial<YourHomeMachineInput> & Pick<YourHomeMachineInput, 'id'>,
): YourHomeMachineInput => ({
  name: input.id,
  online: true,
  lastSeenAt: null,
  isThisComputer: false,
  sessions: [],
  ...input,
});

describe('Your Home model', () => {
  it('counts what needs you and what works on online machines only, and shows no session of an offline one', () => {
    const model = buildYourHomeModel([
      machine({
        id: 'studio',
        online: false,
        lastSeenAt: 1_000,
        sessions: ['need', 'work'],
      }),
      machine({ id: 'mbp', sessions: ['idle', 'need', 'work'] }),
      machine({ id: 'devbox', sessions: ['work', 'idle'] }),
    ]);
    expect(model.machines.map((entry) => entry.id)).toEqual([
      'mbp',
      'devbox',
      'studio',
    ]);
    expect(model.machines[0]).toMatchObject({
      shown: ['work', 'need', 'idle'],
      needsYou: 1,
      working: 1,
    });
    expect(model.machines[2]).toMatchObject({
      online: false,
      lastSeenAt: 1_000,
      shown: [],
      needsYou: 0,
    });
    expect(model).toMatchObject({ online: 2, needsYou: 1, working: 2 });
    expect(resolveYourHomeHeaderFact(model)).toEqual({
      kind: 'needsYou',
      count: 1,
    });
  });

  it('says how much is working when nothing needs you, and nothing for an empty Home', () => {
    expect(
      resolveYourHomeHeaderFact(
        buildYourHomeModel([
          machine({ id: 'devbox', sessions: ['work', 'work', 'idle'] }),
        ]),
      ),
    ).toEqual({ kind: 'working', count: 2 });
    const empty = buildYourHomeModel([]);
    expect(empty).toMatchObject({ machines: [], online: 0 });
    expect(resolveYourHomeHeaderFact(empty)).toBeNull();
  });
});

describe('Your Home past the lab’s three machines', () => {
    it('puts machines that need you first, then working ones, then online, then offline', () => {
        const model = buildYourHomeModel([
            machine({ id: 'off', online: false }),
            machine({ id: 'idle', sessions: ['idle'] }),
            machine({ id: 'work', sessions: ['work'] }),
            machine({ id: 'need', sessions: ['idle', 'need'] }),
        ]);
        expect(model.machines.map(entry => entry.id)).toEqual(['need', 'work', 'idle', 'off']);
    });

});

describe('Your Home legend fit', () => {
  const fleet = (count: number) =>
    buildYourHomeModel(
      Array.from({ length: count }, (_, index) =>
        machine({ id: `m${index}`, online: index < 2, sessions: index < 2 ? ['need'] : [] }),
      ),
    ).machines;

  it('names every machine when the rows fit', () => {
    const machines = fleet(3);
    expect(fitYourHomeLegend(machines, 120, true)).toEqual({ shown: machines, more: 0 });
  });

  it('folds the rest into one "more" row that takes the last row of room, so the orbit draws only named machines', () => {
    const machines = fleet(57);
    // 102 px of compact rows: three rows, one of them the "more" row.
    const fit = fitYourHomeLegend(machines, 102, true);
    expect(fit.shown.map((entry) => entry.id)).toEqual(['m0', 'm1']);
    expect(fit.more).toBe(55);
  });
});

describe('Your Home layout', () => {
  it('keeps each size\'s own composition at its card width', () => {
    expect(resolveYourHomeLayout('small', 262)).toBe('small');
    expect(resolveYourHomeLayout('medium', 430)).toBe('medium');
    expect(resolveYourHomeLayout('wide', 900)).toBe('wide');
    expect(resolveYourHomeLayout('full', 900)).toBe('full');
    expect(resolveYourHomeLayout('large', 900)).toBe('full');
    expect(resolveYourHomeLayout(undefined, 262)).toBe('medium');
  });

  it('stacks the machines under the scene on a card too narrow for names beside it', () => {
    expect(resolveYourHomeLayout('full', 336)).toBe('medium');
    expect(resolveYourHomeLayout('wide', 336)).toBe('medium');
    expect(resolveYourHomeLayout('small', 336)).toBe('small');
  });

  it('composes a half-width size that its row stretched across the card as the wide size does', () => {
    expect(resolveYourHomeLayout('medium', 884)).toBe('full');
    expect(resolveYourHomeLayout('small', 884)).toBe('wide');
  });
});
