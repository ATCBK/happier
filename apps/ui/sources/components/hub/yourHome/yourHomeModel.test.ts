import { describe, expect, it } from 'vitest';

import {
  buildYourHomeModel,
  resolveYourHomeHeaderFact,
  type YourHomeMachineInput,
} from './yourHomeModel';
import { layoutYourHomeScene } from './yourHomeScene';

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

describe('Your Home orbit scene (lab at-widget.js scene())', () => {
  it('places moons on their orbits and trails sessions behind them, dimming offline orbits', () => {
    const scene = layoutYourHomeScene(
      262,
      196,
      [
        { online: true, shown: ['work', 'need'] },
        { online: false, shown: [] },
      ],
      {
        pr: 40,
        radii: [1.55, 1.97, 2.4].map((k) => k * 40),
        angles: [-38, 214, 128],
      },
    );
    expect(scene.orbits).toEqual([
      { r: 62, off: false },
      { r: 79, off: true },
    ]);
    expect(scene.moons[0]!.x).toBeCloseTo(
      131 + Math.cos((-38 * Math.PI) / 180) * 62,
      6,
    );
    expect(scene.sessions.map((session) => session.state)).toEqual([
      'work',
      'need',
    ]);
    // The first session trails 11 px of arc behind its moon (counter-clockwise on the right side).
    const first = scene.sessions[0]!;
    const angle = -38 - (11 / 62) * (180 / Math.PI);
    expect(first.x).toBeCloseTo(
      131 + Math.cos((angle * Math.PI) / 180) * 62,
      6,
    );
    expect(scene.canvas).toEqual({ left: 131 - 84, top: 98 - 84, size: 168 });
  });

  it('draws two quiet orbits around an empty Home', () => {
    const scene = layoutYourHomeScene(262, 120, [], { pr: 18, small: true });
    expect(scene.orbits).toEqual([
      { r: 35, off: true },
      { r: 62, off: true },
    ]);
    expect(scene.moons).toEqual([]);
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

    it('draws a shared outer orbit once and spreads its moons evenly', () => {
        const five = Array.from({ length: 5 }, () => ({ online: true, shown: [] as const }));
        const scene = layoutYourHomeScene(300, 300, five, { pr: 40, radii: [62, 79, 96], angles: [-38, 214, 128] });
        expect(scene.orbits.map(orbit => orbit.r)).toEqual([62, 79, 96]);
        const outer = scene.moons.slice(2).map(moon => Math.round(Math.atan2(moon.y - scene.py, moon.x - scene.px) * 180 / Math.PI));
        expect(new Set(outer).size).toBe(3);
        expect(outer[0]).toBe(128);
    });
});
