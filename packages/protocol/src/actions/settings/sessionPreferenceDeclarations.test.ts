import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { connectedServiceProfileKey } from '../../connect/connectedServiceProfilePreferences.js';
import { buildBuiltInAccountSettingMutationV1, readBuiltInAccountSettingValueV1,
  readBuiltInSettingDeclarationV1 } from './settingsDeclarations.js';

describe('portable Session and connected-account preferences', () => {
  const externalAgentTarget = 'agent:acme.agent.review/review';
  const externalProviderAccount = connectedServiceProfileKey({ serviceId: 'acme.provider.cloud/compute', profileId: 'work' });
  const cases = [
    ['session.favoriteDirectories', 'favoriteDirectories', ['~/projects', 'C:\\code']],
    ['session.favoriteMachines', 'favoriteMachines', ['machine-work', 'machine-home']],
    ['session.favoriteAgents', 'favoriteBackendTargetKeysV1', [externalAgentTarget]],
    ['attachments.uploadsDirectory', 'attachmentsUploadsWorkspaceRelativeDir', '.happier/files'],
    ['permissions.agentStorage', 'newSessionDefaultPersistenceModeByTargetKeyV1', { [externalAgentTarget]: 'direct' }],
    ['connectedServices.pinnedUsageWindows', 'connectedServicesQuotaPinnedMeterIdsByKey', { [externalProviderAccount]: ['daily', 'monthly'] }],
  ] as const;

  it.each(cases)('admits %s and preserves unrelated Account preferences', (anchor, key, value) => {
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    expect(declaration?.storage).toMatchObject({ scope: 'account', access: 'read_write' });
    if (!declaration) throw new Error(`Missing preference declaration: ${anchor}`);
    const before = accountSettingsParse({ transcriptShowToolCalls: false });
    const mutation = buildBuiltInAccountSettingMutationV1(declaration, before, value);
    expect(mutation).toEqual({ [key]: value });
    const after = accountSettingsParse({ ...before, ...mutation });
    expect(readBuiltInAccountSettingValueV1(declaration, after)).toEqual(value);
    expect(after.transcriptShowToolCalls).toBe(false);
    expect(buildBuiltInAccountSettingMutationV1(declaration, before, false)).toBeNull();
  });

  it('keeps the upload folder relative and normalizes the same separators as the UI control', () => {
    // Only new writes become stricter: retained predecessor values keep the same stored reader.
    expect(accountSettingsParse({ attachmentsUploadsWorkspaceRelativeDir: '../retained' })
      .attachmentsUploadsWorkspaceRelativeDir).toBe('../retained');
    const declaration = readBuiltInSettingDeclarationV1('attachments.uploadsDirectory');
    expect(declaration?.storage).toBeDefined();
    if (!declaration) throw new Error('Missing upload directory declaration');
    const before = accountSettingsParse({});
    expect(buildBuiltInAccountSettingMutationV1(declaration, before, '  .happier\\files//images  '))
      .toEqual({ attachmentsUploadsWorkspaceRelativeDir: '.happier/files/images' });
    for (const value of ['', '/tmp/uploads', '\\uploads', '../uploads', 'files/./images', 'files/../images']) {
      expect(buildBuiltInAccountSettingMutationV1(declaration, before, value), value).toBeNull();
    }
  });

  it('keeps favorite Agent target order and rejects malformed targets without a bundled-id allowlist', () => {
    const declaration = readBuiltInSettingDeclarationV1('session.favoriteAgents');
    expect(declaration).not.toBeNull();
    if (!declaration) throw new Error('Missing favorite Agent declaration');
    const before = accountSettingsParse({});
    const bundled = 'agent:happier.agent.codex/codex';
    expect(buildBuiltInAccountSettingMutationV1(declaration, before, [externalAgentTarget, bundled, externalAgentTarget]))
      .toEqual({ favoriteBackendTargetKeysV1: [externalAgentTarget, bundled] });
    expect(buildBuiltInAccountSettingMutationV1(declaration, before, [externalAgentTarget, 'not-a-target']))
      .toBeNull();
  });
});
