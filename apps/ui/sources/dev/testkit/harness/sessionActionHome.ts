import { serveActionHomes } from './actionHomesHttpHarness';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

/** A signed-in Home for Session UI actions; domain logic and the Action front door remain real. */
export async function serveSessionActionHome(params: Parameters<typeof serveActionHomes>[0] = {
    homes: [{ key: 'session', serverUrl: 'https://session-actions.test', accountId: 'session-account', currentAccount: true }],
    route: () => undefined,
}) {
    const sync = await loadSyncSingletonForTests();
    try {
        const home = await serveActionHomes(params);
        return {
            ...home,
            serverId: getActiveServerSnapshot().serverId,
            dispose() {
                try {
                    home.dispose();
                } finally {
                    sync.dispose();
                }
            },
        };
    } catch (error) {
        sync.dispose();
        throw error;
    }
}
