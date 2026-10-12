import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { readBuiltInSettingDeclarationV1, parseBuiltInAccountSettingValueV1, buildBuiltInAccountSettingMutationV1 } from './settingsDeclarations.js';
import { readPortableAccountSettingBindingV1 } from './accountSettingBindings.js';

describe('declared Agent Account preference owners', () => {
  it.each([
    ['agents.defaultPermission', 'sessionDefaultPermissionModeByTargetKey', 'default'],
    ['agents.enabled', 'backendEnabledByTargetKey', false],
    ['agents.executableSource', 'backendCliSourcePreferenceByTargetKey', 'managed-first'],
  ] as const)('admits a keyed %s intent and preserves other targets on rebase', (anchor, key, value) => {
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    expect(declaration).not.toBeNull();
    const intent = { agentTargetKey: 'agent:happier.agent.codex/codex', value };
    expect(parseBuiltInAccountSettingValueV1(declaration!, intent).success).toBe(true);
    const current = accountSettingsParse({ [key]: { 'agent:happier.agent.claude/claude': value } });
    const patch = buildBuiltInAccountSettingMutationV1(declaration!, current, intent);
    expect(patch).toMatchObject({ [key]: { 'agent:happier.agent.claude/claude': value, 'agent:happier.agent.codex/codex': value } });
    expect(parseBuiltInAccountSettingValueV1(declaration!, { ...intent, extra: true }).success).toBe(false);
    expect(parseBuiltInAccountSettingValueV1(declaration!, { ...intent, agentTargetKey: 'bogus' }).success).toBe(false);
  });
  it('per-Agent sharing requires real consent, rechecks it on rebase, and preserves defaults and other Agents', async () => {
    const declaration = readBuiltInSettingDeclarationV1('connectedServicesAgentSignIn.sharingPerAgent')!;
    const binding = readPortableAccountSettingBindingV1(declaration);
    expect(binding && 'prepare' in binding).toBe(true);
    if (!binding || !('prepare' in binding)) return;
    const settings = accountSettingsParse({ connectedServicesProviderStateSharingSettingsV1: { v: 1,
      defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {} } });
    const input = { agentId: 'codex', stateMode: 'shared' };
    expect(await binding.prepare(settings, input, { readProviderStateSharingRiskAgentIds: () => ['codex'] }))
      .toEqual({ status: 'confirmation_required', agentIds: ['codex'] });
    const prepared = await binding.prepare(settings, input, { readProviderStateSharingRiskAgentIds: () => ['codex'],
      confirmProviderStateSharingRiskAgents: async () => true });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    const newer = { ...settings, connectedServicesProviderStateSharingSettingsV1: {
      ...settings.connectedServicesProviderStateSharingSettingsV1, byAgentId: { claude: { configMode: 'copied' as const } } } };
    expect(prepared.mutate(newer)).toMatchObject({ connectedServicesProviderStateSharingSettingsV1: {
      defaults: settings.connectedServicesProviderStateSharingSettingsV1.defaults,
      byAgentId: { claude: { configMode: 'copied' }, codex: { stateMode: 'shared' } },
      acknowledgedRisksByAgentId: { codex: { sharedStatePrivacy: true } },
    } });
  });
});
