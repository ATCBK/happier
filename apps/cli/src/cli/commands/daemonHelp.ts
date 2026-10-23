import { cmd, sectionTitle } from '@happier-dev/cli-common/output';

export function printDaemonHelp(): void {
  console.log([
    `${sectionTitle('happier daemon')} - Daemon management`,
    '',
    sectionTitle('Usage:'),
    `  ${cmd('happier daemon start')}                 Start the daemon (detached)`,
    `  ${cmd('happier daemon start --takeover')}      Start and take over an existing manual relay runtime`,
    `  ${cmd('happier daemon start --plugin-recovery')}  Start without externally installed plugin activation for repair`,
    `  ${cmd('happier daemon restart')}               Restart the daemon (stop → start)`,
    `  ${cmd('happier daemon restart --restart-session-runners')}  Restart the daemon, then refresh daemon-started session runners`,
    `  ${cmd('happier daemon restart-session-runners')}  Refresh stale daemon-started session runners`,
    `  ${cmd('happier daemon restart-session-runners --on-update on|off')}  Set automatic stale-runner refresh at daemon startup`,
    `  ${cmd('happier daemon stop')}                  Stop a manual daemon (sessions stay alive; use happier service stop for installed background services)`,
    `  ${cmd('happier daemon stop --kill-sessions')}  Stop a manual daemon and its tracked sessions`,
    `  ${cmd('happier daemon stop --all')}            Stop daemons for all configured servers`,
    `  ${cmd('happier daemon status')}                Show daemon status`,
    `  ${cmd('happier daemon status --all')}          Show daemon status for all configured servers`,
    `  ${cmd('happier daemon list')}                  List active sessions`,
    `  ${cmd('happier daemon install')}               Legacy alias for ${cmd('happier service install')}`,
    `  ${cmd('happier daemon uninstall')}             Legacy alias for ${cmd('happier service uninstall')}`,
    `  ${cmd('happier daemon service')}               Legacy alias for ${cmd('happier service')}`,
    `  ${cmd('happier daemon service list')}          Legacy alias for ${cmd('happier service list')}`,
    '',
    '  Prefix with --server/--server-url to target a specific server profile for this invocation.',
    '  For installed background services, use happier service start|stop|restart.',
    `  Canonical service command: ${cmd('happier service install')}`,
    `  Example: ${cmd('happier --server company service install')}`,
    '',
    `  Stop stale daemons and review confirmed left-behind processes with ${cmd('happier doctor clean')}`,
    '',
    `${sectionTitle('Note:')} The daemon runs in the background and manages Happier sessions.`,
    `${sectionTitle('To review left-behind processes:')} Use ${cmd('happier doctor clean')}`,
    '',
  ].join('\n'));
}

