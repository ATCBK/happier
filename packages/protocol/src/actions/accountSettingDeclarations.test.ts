import { describe, expect, it } from 'vitest';
import { isAccountSettingActionSurfaceAllowedV1, isPresentUserSettingWriteV1 } from './accountSettingDeclarations.js';

describe('Account transcript visibility setting admission', () => {
  it('lets the shared Action policy admit transcript visibility preference mutations', () => {
    for (const actionId of ['settings.set', 'settings.reset', 'settings.invoke']) {
      const input = { anchor: 'transcript.showToolCalls' };
      expect(isPresentUserSettingWriteV1(actionId, input)).toBe(false);
      for (const surface of ['agent', 'mcp']) {
        expect(isAccountSettingActionSurfaceAllowedV1(actionId, input, surface)).toBe(true);
        expect(isAccountSettingActionSurfaceAllowedV1(actionId, { anchor: 'delegation.workDepthLimit' }, surface)).toBe(true);
      }
      expect(isAccountSettingActionSurfaceAllowedV1(actionId, input, 'ui')).toBe(true);
      expect(isAccountSettingActionSurfaceAllowedV1(actionId, input, 'cli')).toBe(true);
    }
  });
});
