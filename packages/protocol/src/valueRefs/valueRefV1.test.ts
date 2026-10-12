import { describe, expect, it } from 'vitest';
import { ValueRefV1Schema, resolveValueRefPlaintextV1, listValueRefSecretIdsV1 } from './valueRefV1.js';

describe('value references', () => {
  it('resolves template variables without reinterpreting substituted text', () => {
    const ref = ValueRefV1Schema.parse({ t: 'template', template: 'Bearer {api_key}/{region}/{api_key}', vars: {
      api_key: { t: 'savedSecret', secretId: 'personal-key' }, region: { t: 'literal', v: 'local' },
    } });
    expect(resolveValueRefPlaintextV1(ref, () => 'secret-{region}')).toBe('Bearer secret-{region}/local/secret-{region}');
    expect(listValueRefSecretIdsV1(ref)).toEqual(['personal-key']);
    expect(resolveValueRefPlaintextV1(ref, () => null)).toBeNull();
  });

  it('refuses a missing template variable instead of leaving a usable partial credential', () => {
    const ref = ValueRefV1Schema.parse({ t: 'template', template: 'Bearer {missing}', vars: {} });
    expect(resolveValueRefPlaintextV1(ref, () => 'unrelated')).toBeNull();
  });

  it('retains predecessor literals and secret references and leaves attested facts to the runtime', () => {
    expect(resolveValueRefPlaintextV1(ValueRefV1Schema.parse({ t: 'literal', v: '${KEY}' }), () => null)).toBe('${KEY}');
    expect(resolveValueRefPlaintextV1(ValueRefV1Schema.parse({ t: 'savedSecret', secretId: 'personal-key' }), () => 'key')).toBe('key');
    expect(resolveValueRefPlaintextV1(ValueRefV1Schema.parse({ t: 'sessionAttested', field: 'sessionId' }), () => null)).toBeNull();
    expect(ValueRefV1Schema.safeParse({ t: 'template', template: '{key}', vars: {
      key: { t: 'template', template: 'nested', vars: {} },
    } }).success).toBe(false);
  });
});
