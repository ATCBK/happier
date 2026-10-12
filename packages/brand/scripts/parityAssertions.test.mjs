import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStructuralParity } from './parityAssertions.mjs';

test('portable structure checks preserve counts and identities without judging numeric parity', () => {
  const expected = { dots: [{ i: 12, rgb: [104.5, 0, 201.2], x: 0.6715539692472262 }], commands: [['set', 'fillStyle', 'rgba(10,20,30,0.4)']] };
  const actual = { dots: [{ i: 12, rgb: [105.5, 0, 201.2], x: 0.671554 }], commands: [['set', 'fillStyle', 'rgba(12,20,30,0.5)']] };
  assertStructuralParity(actual, expected, 'portable');
  for (const wrong of [
    { ...actual, dots: [] },
    { ...actual, dots: [{ ...actual.dots[0], i: 13 }] },
    { ...actual, dots: [{ ...actual.dots[0], rgb: [105.5, 0] }] },
    { ...actual, dots: [{ ...actual.dots[0], x: NaN }] },
    { ...actual, commands: [['set', 'strokeStyle', 'rgba(12,20,30,0.5)']] },
    { ...actual, commands: [['set', 'fillStyle', '#fff']] },
  ]) assert.throws(() => assertStructuralParity(wrong, expected, 'must reject'));
});
test('portable paint commands keep gradient identities exact', () => {
  for (const operation of ['createLinearGradient', 'createRadialGradient', 'addColorStop']) {
    const expected = [operation, 1, 0.6715539692472262];
    assertStructuralParity([operation, 1, 0.671554], expected, operation);
    assert.throws(() => assertStructuralParity([operation, 1 + 1e-13, expected[2]], expected, operation));
  }
});
