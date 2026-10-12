import type { TeamCredentialUsageExportInputV1 } from '@happier-dev/protocol/teams';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { exportUsageTextDocument } from '@/components/settings/usage/usageExportFile';

export { buildTeamCredentialUsageCsv, type TeamCredentialUsageExportInput } from '@happier-dev/protocol/teams';

/** The UI requests the same file as an Agent, then explicitly delivers it on this client. */
export async function exportTeamCredentialUsageCsv(input: TeamCredentialUsageExportInputV1 & Readonly<{
    scope: ServerAccountScope;
}>): Promise<boolean> {
    const account = await captureLazyActionAccountContext(input.scope.serverId);
    try {
        if (account.accountId !== input.scope.accountId) return false;
        const { scope, ...request } = input;
        const outcome = await runTeamAction({ scope, actionId: 'teams.credentials.usage.export',
            input: request, parse: value => UsageFileResultSchema.parse(value) });
        account.assertCurrent();
        if (outcome.kind !== 'succeeded') return false;
        const file = outcome.value;
        return await exportUsageTextDocument({ content: new TextDecoder().decode(decodeBase64(file.base64)),
            fileName: file.fileName, mimeType: file.mediaType, isCurrent: account.accountLifetime.isCurrent });
    } finally {
        account.dispose();
    }
}
