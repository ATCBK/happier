import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: ACP permission prompt matrix in provider specs', () => {
  it('schedules CodeBuddy approval-preset scenarios and retains native resume history coverage', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const codebuddy = providers.find((provider) => provider.id === 'codebuddy');
    expect(codebuddy).toBeTruthy();
    const modes = ['default', 'safe_yolo', 'read_only', 'yolo'];
    for (const mode of modes) {
      expect(codebuddy?.scenarioRegistry.tiers.extended).toContain(`permission_mode_${mode}_outside_workspace`);
    }
    expect(codebuddy?.permissions?.acp?.toolPermissionPromptsByMode).toEqual({
      default: true, 'safe-yolo': false, 'read-only': false, yolo: false,
    });
    expect(codebuddy?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode).toEqual({
      default: true, 'safe-yolo': true, 'read-only': false, yolo: true,
    });
    for (const id of ['codebuddy', 'fx', 'droid']) {
      expect(providers.find((provider) => provider.id === id)?.scenarioRegistry.tiers.extended)
        .toContain('acp_resume_fresh_session_imports_history');
    }
  });
  it('defines complete permission matrices for each provider that schedules permission-mode scenarios', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const acpProviders = providers.filter((provider) => {
      if (provider.protocol !== 'acp') return false;
      const scenarioIds = [
        ...provider.scenarioRegistry.tiers.smoke,
        ...provider.scenarioRegistry.tiers.extended,
      ];
      return scenarioIds.some((scenarioId) => scenarioId.startsWith('permission_mode_'));
    });
    expect(acpProviders.length).toBeGreaterThan(0);

    for (const provider of acpProviders) {
      const promptsByMode = (provider.permissions as any)?.acp?.toolPermissionPromptsByMode;
      const outsideWriteByMode = (provider.permissions as any)?.acp?.outsideWorkspaceWriteAllowedByMode;
      const outsideWriteMustCompleteByMode = (provider.permissions as any)?.acp?.outsideWorkspaceWriteMustCompleteByMode;
      expect(promptsByMode, `${provider.id} is missing permissions.acp.toolPermissionPromptsByMode`).toBeTruthy();
      expect(outsideWriteByMode, `${provider.id} is missing permissions.acp.outsideWorkspaceWriteAllowedByMode`).toBeTruthy();
      expect(
        outsideWriteMustCompleteByMode,
        `${provider.id} is missing permissions.acp.outsideWorkspaceWriteMustCompleteByMode`,
      ).toBeTruthy();
      expect(typeof promptsByMode.default).toBe('boolean');
      expect(typeof promptsByMode['safe-yolo']).toBe('boolean');
      expect(typeof promptsByMode['read-only']).toBe('boolean');
      expect(typeof promptsByMode.yolo).toBe('boolean');
      expect(typeof outsideWriteByMode.default).toBe('boolean');
      expect(typeof outsideWriteByMode['safe-yolo']).toBe('boolean');
      expect(typeof outsideWriteByMode['read-only']).toBe('boolean');
      expect(typeof outsideWriteByMode.yolo).toBe('boolean');
      expect(typeof outsideWriteMustCompleteByMode.default).toBe('boolean');
      expect(typeof outsideWriteMustCompleteByMode['safe-yolo']).toBe('boolean');
      expect(typeof outsideWriteMustCompleteByMode['read-only']).toBe('boolean');
      expect(typeof outsideWriteMustCompleteByMode.yolo).toBe('boolean');
    }
  });

  it('keeps Droid permission behavior unverified instead of scheduling unsafe matrix scenarios', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const droid = providers.find((provider) => provider.id === 'droid');
    expect(droid).toBeTruthy();
    expect(droid?.permissions?.acp?.toolPermissionPromptsByMode).toBeUndefined();
    expect(droid?.permissions?.acp?.outsideWorkspaceWriteAllowedByMode).toBeUndefined();
    expect(droid?.permissions?.acp?.outsideWorkspaceWriteMustCompleteByMode).toBeUndefined();
    expect([
      ...(droid?.scenarioRegistry.tiers.smoke ?? []),
      ...(droid?.scenarioRegistry.tiers.extended ?? []),
    ].some((scenarioId) => scenarioId.startsWith('permission_mode_'))).toBe(false);
  });
});
