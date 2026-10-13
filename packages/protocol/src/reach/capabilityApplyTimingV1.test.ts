import { describe, expect, it } from 'vitest';
import { CapabilityApplyTimingV1Schema, readCapabilityLaunchRestartFromMetadataV1, resolveCapabilityApplyTimingV1, type CapabilityApplyTimingInputV1 } from './capabilityApplyTimingV1.js';
import { SessionRunnerRuntimeStateV1Schema } from '../sessions/control/sessionRunnerRuntimeV1.js';

const resumable = { vendorResume: 'supported', skillsLiveReload: 'unsupported' } as const;
describe('P8 acceptance timing and D34 launch eligibility', () => {
  it.each(['windows_terminal', 'windows_console'] as const)('uses actual %s launch mode despite absent or generic daemon eligibility', mode => {
    const sessionRunnerRuntimeV1 = SessionRunnerRuntimeStateV1Schema.parse({
      v: 1, sessionId: 'session', observedAtMs: 1,
      runner: { entrypointSource: 'process_command', startedBy: 'daemon', startingMode: 'remote' },
      daemon: { currentEntrypointSource: 'launch_spec' }, versionState: 'current', statusSource: 'daemon_tracking',
      plannedRestart: { supported: true, eligible: false, disabledReason: 'missing_resume_identity' },
    });
    for (const metadata of [{ terminal: { mode } }, { terminal: { mode }, sessionRunnerRuntimeV1 }]) {
      const launchRestart = readCapabilityLaunchRestartFromMetadataV1(metadata);
      expect(launchRestart).toEqual({ refused: 'windows_hosted_runner' });
      expect(resolveCapabilityApplyTimingV1({ kind: 'mcp_server', sessionRunning: true, agent: resumable, launchRestart }))
        .toEqual({ t: 'restart_to_apply', restartBy: 'user' });
    }
    expect(readCapabilityLaunchRestartFromMetadataV1({ terminal: { mode: 'plain', requested: 'windows_terminal' } })).toBe('automatic');
    expect(readCapabilityLaunchRestartFromMetadataV1({ terminal: { mode: 'unknown' } })).toBe('automatic');
  });
  it('keeps an explicit terminal launch awaiting terminal restart without requiring a daemon projection', () => {
    const launchRestart = readCapabilityLaunchRestartFromMetadataV1({ startedBy: 'terminal' });
    expect(launchRestart).toEqual({ refused: 'not_daemon_started' });
    expect(resolveCapabilityApplyTimingV1({ kind: 'mcp_server', sessionRunning: true, agent: resumable, launchRestart }))
      .toEqual({ t: 'restart_to_apply', restartBy: 'terminal' });
    expect(readCapabilityLaunchRestartFromMetadataV1({})).toBe('automatic');
    expect(readCapabilityLaunchRestartFromMetadataV1({ startedBy: 'unknown' })).toBe('automatic');
    expect(readCapabilityLaunchRestartFromMetadataV1({ startedBy: 'daemon' })).toBe('automatic');
    expect(readCapabilityLaunchRestartFromMetadataV1({ startedBy: 'terminal', terminal: { mode: 'windows_console' } }))
      .toEqual({ refused: 'not_daemon_started' });
  });
  it.each([
    [{ kind: 'mcp_server', sessionRunning: false, agent: resumable, launchRestart: 'automatic' }, { t: 'session_not_running' }],
    [{ kind: 'skill', sessionRunning: true, agent: { ...resumable, skillsLiveReload: 'supported' }, launchRestart: 'automatic' }, { t: 'applied_now' }],
    [{ kind: 'native_skill', sessionRunning: true, agent: { ...resumable, skillsLiveReload: 'supported' }, launchRestart: 'automatic' }, { t: 'next_turn' }],
    [{ kind: 'skill', sessionRunning: true, agent: resumable, launchRestart: 'automatic' }, { t: 'next_turn' }],
    [{ kind: 'mcp_server', sessionRunning: true, agent: { ...resumable, vendorResume: 'experimental' }, launchRestart: 'automatic' }, { t: 'next_turn' }],
    [{ kind: 'mcp_server', sessionRunning: true, agent: { ...resumable, vendorResume: 'unsupported' }, launchRestart: 'automatic' }, { t: 'new_sessions_only' }],
    [{ kind: 'mcp_server', sessionRunning: true, agent: resumable, launchRestart: { refused: 'windows_hosted_runner' } }, { t: 'restart_to_apply', restartBy: 'user' }],
    [{ kind: 'mcp_server', sessionRunning: true, agent: resumable, launchRestart: { refused: 'not_daemon_started' } }, { t: 'restart_to_apply', restartBy: 'terminal' }],
    [{ kind: 'native_skill', sessionRunning: true, agent: resumable, launchRestart: { refused: 'not_remote_started' } }, { t: 'restart_to_apply', restartBy: 'terminal' }],
    [{ kind: 'skill', sessionRunning: true, agent: { vendorResume: 'unsupported', skillsLiveReload: 'supported' }, launchRestart: { refused: 'windows_hosted_runner' } }, { t: 'applied_now' }],
    [{ kind: 'native_skill', sessionRunning: true, agent: { vendorResume: 'unsupported', skillsLiveReload: 'supported' }, launchRestart: { refused: 'windows_hosted_runner' } }, { t: 'new_sessions_only' }],
  ] satisfies [CapabilityApplyTimingInputV1, unknown][])('resolves %j', (input, expected) => {
    const output = resolveCapabilityApplyTimingV1(input);
    expect(output).toEqual(expected);
    expect(CapabilityApplyTimingV1Schema.parse(output)).toEqual(output);
  });
});
