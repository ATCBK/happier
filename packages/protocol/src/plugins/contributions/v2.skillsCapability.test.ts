import { describe, expect, it } from 'vitest';
import { PluginAgentContributionV2Schema, PluginAgentAcpSkillsSessionDeliveryV2Schema } from './v2.js';

const skills = { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' };
const delivery = { kind: 'env_path_list', envKey: 'AGENT_SKILLS', separator: ',', value: 'skills_root' };
function agent(capability: unknown = skills, sessionDelivery: unknown = delivery, mcp?: unknown) {
  return {
    id: 'fixture', title: 'Fixture', primary: 'sessions',
    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true }, skills: capability },
    runtime: {
      kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
      ...(sessionDelivery === null ? {} : { definition: { skills: { sessionDelivery }, ...(mcp ? { mcp } : {}) } }),
    },
  };
}

describe('Agent skills declarations', () => {
  it('admits matching declarative session delivery, including skills-only behavior', () => {
    expect(PluginAgentContributionV2Schema.safeParse(agent()).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse(agent({ ...skills, materialization: 'copy' })).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse(agent(skills, {
      kind: 'defaults_file_env', envKey: 'AGENT_DEFAULTS',
      directoriesKeyPath: ['skills', 'directories'], disabledKeyPath: ['skills', 'disabled'],
    })).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse({ ...agent(), runtime: { kind: 'custom' } }).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse({
      id: 'fixture', title: 'Fixture', primary: 'executionRuns', runtime: { kind: 'custom' },
      capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true }, skills },
    }).success).toBe(true);
  });
  it('requires the ACP delivery declaration and capability to agree', () => {
    expect(PluginAgentContributionV2Schema.safeParse(agent(skills, null)).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse(agent({ ...skills, delivery: 'none' })).success).toBe(false);
    const missingCapability = agent();
    const { skills: _skills, ...capabilities } = missingCapability.capabilities;
    expect(PluginAgentContributionV2Schema.safeParse({ ...missingCapability, capabilities }).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse(agent({ ...skills, delivery: 'none' }, null)).success).toBe(true);
  });
  it('requires a native config root for native skills directory delivery', () => {
    const nativeDelivery = { kind: 'native_config_skills_dir', subdirectory: 'skills' };
    expect(PluginAgentContributionV2Schema.safeParse(agent(skills, nativeDelivery)).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse(agent(skills, nativeDelivery, {
      policy: 'drop', nativeSessionConfig: {
        configRootEnvKey: { posix: 'XDG_CONFIG_HOME', win32: 'APPDATA' },
        homeRelativeConfigRoot: { posix: ['.config'], win32: ['AppData', 'Roaming'] },
        directory: 'fixture', fileName: 'mcp.json', serversKey: 'mcpServers',
      },
    })).success).toBe(true);
  });
  it('keeps the native skills subdirectory inside its portable Agent directory', () => {
    for (const subdirectory of ['skills', 'agent-skills']) {
      expect(PluginAgentAcpSkillsSessionDeliveryV2Schema.safeParse({ kind: 'native_config_skills_dir', subdirectory }).success).toBe(true);
    }
    for (const subdirectory of ['..', '../skills', '..\\skills', '/skills', 'C:\\skills', 'nested/skills', 'NUL']) {
      expect(PluginAgentAcpSkillsSessionDeliveryV2Schema.safeParse({ kind: 'native_config_skills_dir', subdirectory }).success).toBe(false);
    }
  });
  it('rejects unknown executable declaration keys at every skills boundary', () => {
    expect(PluginAgentContributionV2Schema.safeParse(agent({ ...skills, unexpected: true })).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse(agent({ ...skills, nativeRoots: { user: [['.agents', 'skills']], unexpected: [] } })).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse(agent(skills, { ...delivery, unexpected: true })).success).toBe(false);
    const declaration = agent();
    expect(PluginAgentContributionV2Schema.safeParse({ ...declaration, runtime: {
      ...declaration.runtime, definition: { skills: { sessionDelivery: delivery, unexpected: true } },
    } }).success).toBe(false);
  });
});
