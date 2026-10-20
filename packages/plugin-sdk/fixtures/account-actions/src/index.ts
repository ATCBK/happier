import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

const input = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
const writeInput = defineProtocolObject({ key: defineProtocolString(), value: defineProtocolString() }, { policy: 'closed' });
const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } as const;

const plugin = definePlugin({
    id: 'acme.account-actions', version: '1.0.0',
    hostAccess: { required: [], optional: [{
        id: 'account-storage', capability: 'storage.account',
        reason: 'Read and write personal values in this Account.', scope: { enabled: true },
    }] },
    actions: {
        source: { title: 'Read a Machine source', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'safe',
            run: async ({ key }, context) => context.services.actions.execute({ pluginId: 'acme.account-source-provider', localId: 'read' }, { key }),
        },
        echo: { title: 'Echo personal input', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'safe',
            run: async ({ key }, context) => ({ key, surface: context.surface }),
        },
        read: { title: 'Read personal value', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'safe', hostAccess: ['account-storage'],
            run: async ({ key }, context) => {
                const entry = await context.services.storage.account.kv.get(key, { signal: context.signal });
                return { value: entry && !('deleted' in entry) ? entry.value : null };
            },
        },
        write: { title: 'Write personal value', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: writeInput, dangerLevel: 'writesLocal', hostAccess: ['account-storage'],
            confirmation: { title: 'Write personal value?' },
            run: async ({ key, value }, context) => context.services.storage.account.kv.transaction(async (tx) => {
                const entry = await tx.get(key, { signal: context.signal });
                const stored = await tx.set(key, value, { expectedVersion: entry?.version ?? 'absent', signal: context.signal });
                return { version: stored.version };
            }, { signal: context.signal }),
        },
    },
});

export const manifest = plugin.manifest;
export const activate = plugin.activateAccount;
