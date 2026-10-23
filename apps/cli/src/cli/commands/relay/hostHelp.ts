import { renderHelpPage } from '@happier-dev/cli-common/output';

export function showRelayHostHelp(subcommand?: string): void {
  const installUsage = {
    label: 'happier relay host install [--ssh <user@host>] [--mode user|system] [--channel stable|preview|dev] [--env KEY=VALUE]... [--server-binary <path>] [--lan | --expose | --host <ip>] [--preserve-active-server] [--yes] [--json]',
    description: 'Install or update the generic/operator server runtime',
  };
  const usage = subcommand === 'install'
    ? [installUsage]
    : [
        installUsage,
        { label: 'happier relay host status [--ssh <user@host>] [--mode user|system] [--channel stable|preview|dev] [--json]', description: 'Show relay host status' },
        { label: 'happier relay host start|stop|restart|uninstall [--ssh <user@host>] [--mode user|system] [--channel stable|preview|dev] [--yes] [--json]', description: 'Control the relay host service' },
      ];
  console.log(renderHelpPage({
    title: subcommand === 'install' ? 'happier relay host install' : 'happier relay host',
    subtitle: 'Advanced/operator server runtime deployment',
    usage,
    notes: [
      'This command does not create or convert a Personal Home. Use `happier home create [--ssh user@host]` for that.',
      '--lan binds to an auto-detected LAN or Tailscale address.',
      '--expose binds to all interfaces; --host binds to one explicit address.',
      '--preserve-active-server keeps the current CLI relay profile after installation.',
      'A local install asks which address other devices should reach the relay at, and stores it in the relay profile.',
      'Without a terminal, or with --yes, it keeps an already-reachable bind address, otherwise takes the first reachable one, and prints what it chose.',
    ],
  }));
}

