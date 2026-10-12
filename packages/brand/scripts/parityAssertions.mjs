import assert from 'node:assert/strict';

export const captureRuntimeSkip = process.platform === 'linux' && process.arch === 'x64' && /^v24\.21\./.test(process.version)
  ? false : 'non-capture runtime: exact parity requires Linux x64, Node 24.21';

// Full references still prove structure and identities everywhere; numeric parity is capture-only.
export function assertStructuralParity(actual, expected, label) {
  if (Object.is(actual, expected)) return;
  if (typeof actual === 'number' && typeof expected === 'number') {
    assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: finite number`);
    return;
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    // Rounded paint channels are numeric output, not command identity.
    const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.e+-]+)\)$/;
    if (rgba.test(actual) && rgba.test(expected)) return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${label}: array`);
    assert.equal(actual.length, expected.length, `${label}: count`);
    expected.forEach((value, index) => {
      if (index === 1 && ['createLinearGradient', 'createRadialGradient', 'addColorStop'].includes(expected[0])) {
        assert.deepEqual(actual[index], value, `${label}/${index}: gradient identity`);
      } else assertStructuralParity(actual[index], value, `${label}/${index}`);
    });
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual), `${label}: object`);
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label}: ordered keys`);
    for (const key of Object.keys(expected)) {
      if (['i', 'j', 'id', 'gradient'].includes(key)) assert.deepEqual(actual[key], expected[key], `${label}/${key}: identity`);
      else assertStructuralParity(actual[key], expected[key], `${label}/${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, label);
}
