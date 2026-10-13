import { describe, expect, it } from 'vitest';

import {
  buildYourHomeModel,
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
