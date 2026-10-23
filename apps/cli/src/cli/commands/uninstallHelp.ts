import { cmd, sectionTitle } from '@happier-dev/cli-common/output';

export function usage(): string {
    return [
        `${sectionTitle('happier uninstall')} - Uninstall the current managed Happier CLI`,
        '',
        sectionTitle('Usage:'),
        `  ${cmd('happier uninstall [--yes] [--dry-run] [--keep-service] [--json]')}`,
        '',
    ].join('\n');
}

