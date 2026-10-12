import { describe, expect, it } from 'vitest';

import {
  hasBackendTargetSelectionFromCsv,
  normalizeBackendTargetKeysFromCsv,
} from './normalizeBackendTargetKeys';

describe('normalizeBackendTargetKeysFromCsv', () => {
  it('keeps ordinary provider shorthands on legacy agent keys', () => {
    expect(normalizeBackendTargetKeysFromCsv('codex')).toEqual(['agent:codex']);
  });

  it('routes provider shorthands with a settings backend to the concrete configured backend target', () => {
    expect(normalizeBackendTargetKeysFromCsv('antigravity')).toEqual([
      'agent:happier.agent.custom-acp/custom-acp:definition:antigravity',
    ]);
  });

  it('preserves explicit V2 backend target keys', () => {
    expect(normalizeBackendTargetKeysFromCsv('agent:happier.agent.opencode/opencode')).toEqual(['agent:happier.agent.opencode/opencode']);
    expect(normalizeBackendTargetKeysFromCsv('backend:plugin-review-bot')).toEqual(['backend:plugin-review-bot']);
  });

  it('does not treat separator-only values as a backend selection', () => {
    expect(hasBackendTargetSelectionFromCsv(' , , ')).toBe(false);
  });
});
