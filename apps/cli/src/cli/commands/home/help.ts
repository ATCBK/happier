import { renderHelpPage, type HelpPageOptions } from '@happier-dev/cli-common/output';

export async function showHomeHelp(): Promise<void> {
  // Home governance and Account administration are compiled Action leaves
  // under this root. Their rows come from the same descriptor dispatch and
  // completion use, so this page cannot hide or misstate them.
  const { listPublishedActionCliUsageLinesForRoot: listCompiledActionCliUsageLinesForRoot } = await import('@/cli/actions/publishedHelp');
  const compiled = listCompiledActionCliUsageLinesForRoot(['home']);
  const page: HelpPageOptions = {
    title: 'home',
    subtitle: 'Create, connect, and administer Personal Homes',
    usage: [
      { label: 'happier home create [--ssh user@host] [--channel stable|preview|dev] [--mode user|system] [--link-account auto|never] [--replace-services] [--switch-channel] [--yes] [--json]', description: '' },
      { label: 'happier home pair-device [--home PROFILE] [--copy-link]', description: '' },
      { label: 'happier home link-account [--home PROFILE] [--relink]', description: '' },
      { label: 'happier home unlink-account [--home PROFILE]', description: '' },
      { label: 'happier home status [--ssh user@host]', description: '' },
      { label: 'happier home backup [--output PATH] [--ssh user@host]', description: '' },
      { label: 'happier home verify-backup PATH [--ssh user@host]', description: '' },
      { label: 'happier home restore PATH [--ssh user@host] [--yes]', description: '' },
      { label: 'happier home recover-restore [--ssh user@host] [--yes]', description: '' },
      { label: 'happier home relocate --target user@host [--recovery-action finish_move|return_to_source] [--yes]', description: '' },
      { label: 'happier home erase [--ssh user@host] [--backup-first --backup-output PATH] [--yes]', description: '' },
    ],
    sections: [
      ...(compiled.length > 0 ? [{
        title: 'Home administration:',
        rows: compiled.map((row) => ({ label: row, description: '' })),
      }] : []),
      {
        title: 'Runtime targeting options:',
        rows: [
          { label: '--channel stable|preview|dev', description: '' },
          { label: '--mode user|system', description: '' },
        ],
      },
      {
        title: 'Home creation:',
        rows: [
          { label: 'create', description: 'Installs or reuses the managed runtime and atomically creates a Personal Home.' },
          { label: '--ssh user@host', description: 'Creates on a trusted remote host; public ingress is not required for Iroh reachability.' },
          { label: '--replace-services', description: 'Explicitly replaces conflicting managed services while creating this Home.' },
          { label: '--switch-channel', description: 'Explicitly changes the default managed release channel when creation requires it.' },
          { label: 'pair-device', description: 'Starts a new short-lived QR/link session.' },
          { label: 'link-account', description: 'Makes this Home available on your other devices.' },
          { label: 'unlink-account', description: 'Stops future account-based sign-in; devices already signed in keep their access until revoked on the Home.' },
          { label: 'remote administration', description: 'status, backup, verify-backup, restore, recover-restore, and erase accept --ssh.' },
          { label: '--trusted-host-key LINE', description: '--yes trusts an unknown host on first use but never a changed key; this pins the exact new known_hosts line instead.' },
          { label: 'relocate', description: 'Moves this computer\'s Personal Home to the explicit SSH destination in --target.' },
        ],
      },
      {
        title: 'Erase safety:',
        rows: [
          { label: 'backup offer', description: 'erase offers a verified backup before its single destructive confirmation.' },
          { label: '--backup-first --backup-output PATH', description: 'Takes that verified backup without a prompt; PATH must be outside the erased Home data.' },
          { label: '--yes', description: 'Confirms deletion and never creates a backup implicitly.' },
        ],
      },
    ],
  };
  console.log(renderHelpPage(page));
}

