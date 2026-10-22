import type { CommandSuiteEntry } from './runCommandSuite.ts';

export type SharedPackageTestMode = 'local' | 'ci';

export interface SharedPackageTestCommand extends CommandSuiteEntry {
  /** The command remains mandatory in CI, whose workflow provisions its external prerequisite. */
  requiresCiProvisioning?: true;
}

/**
 * Canonical command inventory for package-level tests that do not own a dedicated CI job.
 * The executor, test-wiring classifier, and workflow parity checks all consume this list.
 */
export const SHARED_PACKAGE_TEST_COMMANDS = [
  { id: 'privacy-kit:test', args: ['--filter', 'privacy-kit', '--silent', 'run', 'test'] },
  {
    id: 'privacy-kit:bun',
    args: ['--filter', 'privacy-kit', '--silent', 'run', 'test:runtime:bun'],
    requiresCiProvisioning: true,
  },
  { id: 'protocol', args: ['--filter', '@happier-dev/protocol', '--silent', 'run', 'test'] },
  { id: 'peer-mediation', args: ['--filter', '@happier-dev/peer-mediation', '--silent', 'run', 'test'] },
  { id: 'peer-transport', args: ['--filter', '@happier-dev/peer-transport', '--silent', 'run', 'test'] },
  { id: 'transfers', args: ['--filter', '@happier-dev/transfers', '--silent', 'run', 'test'] },
  { id: 'voice-modelpacks', args: ['--filter', '@happier-dev/voice-modelpacks', '--silent', 'run', 'test'] },
  { id: 'terminal-native', args: ['--filter', '@happier-dev/terminal-native', '--silent', 'run', 'test'] },
  { id: 'sherpa-native', args: ['--filter', '@happier-dev/sherpa-native', '--silent', 'run', 'test'] },
  { id: 'agents', args: ['--filter', '@happier-dev/agents', '--silent', 'run', 'test'] },
  { id: 'cli-common', args: ['--filter', '@happier-dev/cli-common', '--silent', 'run', 'test'] },
  { id: 'release-runtime', args: ['--filter', '@happier-dev/release-runtime', '--silent', 'run', 'test'] },
  { id: 'support', args: ['--filter', '@happier-dev/support', '--silent', 'run', 'test'] },
  { id: 'connection-supervisor', args: ['--filter', '@happier-dev/connection-supervisor', '--silent', 'run', 'test'] },
  { id: 'session-core', args: ['--filter', '@happier-dev/session-core', '--silent', 'run', 'test'] },
  { id: 'bootstrap', args: ['--filter', '@happier-dev/bootstrap', '--silent', 'run', 'test'] },
  { id: 'channels-protocol:build', args: ['--filter', '@happier-dev/channels-protocol', '--silent', 'run', 'build'] },
  { id: 'channels-protocol:test', args: ['--filter', '@happier-dev/channels-protocol', '--silent', 'run', 'test'] },
  { id: 'email-transports-protocol:build', args: ['--filter', '@happier-dev/email-transports-protocol', '--silent', 'run', 'build'] },
  { id: 'email-transports-protocol:test', args: ['--filter', '@happier-dev/email-transports-protocol', '--silent', 'run', 'test'] },
  { id: 'triage-protocol', args: ['--filter', '@happier-dev/triage-protocol', '--silent', 'run', 'test'] },
  { id: 'triage-sources', args: ['--filter', '@happier-dev/triage-sources', '--silent', 'run', 'test'] },
  { id: 'ssh-native', args: ['--filter', '@happier-dev/ssh-native', '--silent', 'run', 'test'] },
  { id: 'audio-stream-native', args: ['--filter', '@happier-dev/audio-stream-native', '--silent', 'run', 'test'] },
  { id: 'desktop', args: ['--filter', '@happier-dev/desktop', '--silent', 'run', 'test'] },
  { id: 'desktop-native', args: ['--filter', '@happier-dev/desktop-native', '--silent', 'run', 'test'] },
  { id: 'iroh-native', args: ['--filter', '@happier-dev/iroh-native', '--silent', 'run', 'test'] },
  { id: 'docs:test', args: ['--filter', 'docs', '--silent', 'run', 'test'] },
  { id: 'docs:content', args: ['--filter', 'docs', '--silent', 'run', 'check:content'] },
  {
    id: 'website',
    args: ['--filter', '@happier-dev/website', '--silent', 'run', 'test'],
    requiresCiProvisioning: true,
  },
  { id: 'test-harness', args: ['--filter', '@happier-dev/tests', '--silent', 'run', 'test:scripts:self'] },
  { id: 'relay-server', args: ['--dir', 'packages/relay-server', '--silent', 'run', 'test'] },
] as const satisfies readonly SharedPackageTestCommand[];

export function selectSharedPackageTestCommands(
  mode: SharedPackageTestMode,
): readonly SharedPackageTestCommand[] {
  if (mode === 'ci') return SHARED_PACKAGE_TEST_COMMANDS;
  return SHARED_PACKAGE_TEST_COMMANDS.filter((command) => !('requiresCiProvisioning' in command));
}
