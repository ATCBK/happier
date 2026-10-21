import type { FastifyInstance } from 'fastify';
import { z } from 'zod/mini';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, FeaturesResponseSchema, decodePlainArtifactStoredContent, type AccountSettings } from '@happier-dev/protocol';
import { deriveArtifactCoarseKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

/** One installed App-target widget with a contributed input type, as the daemon projects it. */
export function createCounterWidgetFixture() {
    const pluginId = 'example.widgets';
    const inputType = { pluginId, localId: 'count-kind' };
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const type = { id: inputType.localId, title: 'Count', semantic: 'count-kind',
        valueSchema: { type: 'string' as const, enum: ['files', 'folders'] }, options: { resource: 'count-kinds' } };
    const binding = normalizePluginUiInlineSurfaceBindingV1({ pluginId, surfaceId: 'counter', rendererId: 'counter', role: 'widget', target: { kind: 'app' } });
    if (!binding) throw new Error('Expected widget binding');
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
        pluginUi: { family: 'pluginUi', entriesById: { counter: { id: 'counter', pluginId, contributionKind: 'surfacePlacement',
            descriptorId: 'counter', occurrenceId, binding, target: binding.target, display: { title: 'Directory count' },
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            inputs: { fields: [{ path: 'filter', title: 'Count', widget: 'select', required: true, inputType }] },
            inputSchema: { type: 'object', properties: { filter: type.valueSchema }, required: ['filter'], additionalProperties: false },
        } } }, inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/count-kind`]: {
            id: `${pluginId}/count-kind`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: type,
        } } },
    } });
    const registry = createResolvedContributionRegistry({ occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
        inputTypes: [{ provenance: 'external', source: { kind: 'path' }, pluginId, identity: inputType,
            manifestPath: '/plugins/widgets/plugin.json', definition: type }],
        resources: [{ provenance: 'external', source: { kind: 'path' }, pluginId,
            definition: { kindVersion: 1, id: 'count-kinds', source: 'dynamic', type: 'config', scope: 'global', contentType: 'application/json' } }],
    });
    const readUiResource = async () => ({ resource: { pluginId, localId: 'count-kinds' }, kind: 'config' as const,
        contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode(JSON.stringify([{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }])) });
    return { pluginId, inputType, projection, registry, readUiResource,
        definition: { kind: 'installed' as const, surface: { pluginId, localId: 'counter' } } };
}

/** The Home features and Account facts every CLI Action composition reads before an Artifact write. */
export function registerAccountHomeHttp(app: FastifyInstance, input: Readonly<{ accountId: string; serverId: string;
    settings?: Pick<AccountSettings, 'actionsSettingsV1'> }>) {
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/profile', async () => ({ id: input.accountId }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: input.settings ?? {} }, version: 1 }));
    return FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: input.serverId } } });
}

type PlainArtifactRow = {
    id: string; ownerAccountId: string; access: 'owner'; encryptionMode: 'plain'; publicAudience: 'none';
    header: string; body: string; dataEncryptionKey: string;
    headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number;
};

/** The Account Artifact HTTP surface (list, read, create, versioned update) over one in-memory plain row set. */
export function registerPlainArtifactRoutes(app: FastifyInstance, accountId: string) {
    const rows = new Map<string, PlainArtifactRow>();
    const seed = (id: string, header: string, body: string) => {
        rows.set(id, { id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none', header, body,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    };
    const idOf = (params: unknown) => String((params as { id: string }).id);
    app.get('/v1/artifacts', async request => {
        const kind = new URL(request.url, 'http://fixture.test').searchParams.get('kind');
        const items = [...rows.values()];
        return kind ? { items: items.filter(row => deriveArtifactCoarseKindV1(z.looseObject({}).parse(decodePlainArtifactStoredContent(row.header))) === kind),
            hasUnclassified: false } : items;
    });
    app.get('/v1/artifacts/:id', async (request, reply) => rows.get(idOf(request.params)) ?? reply.code(404).send({ error: 'not_found' }));
    app.get('/v1/artifacts/:id/access/recipients', async (request, reply) => {
        const row = rows.get(idOf(request.params));
        return row ? { artifactId: row.id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
            provenanceDataEncryptionKey: null, callerProvenanceDataEncryptionKey: null, recipients: [] } : reply.code(404).send({ error: 'not_found' });
    });
    app.get('/v1/artifacts/:id/access/grants', async (request, reply) => {
        const row = rows.get(idOf(request.params));
        return row ? { artifactId: row.id, ownerAccountId: accountId, access: 'owner', grants: [] } : reply.code(404).send({ error: 'not_found' });
    });
    app.post('/v1/artifacts', async request => {
        const create = z.looseObject({ id: z.string(), header: z.string(), body: z.string() }).parse(request.body);
        const incumbent = rows.get(create.id);
        if (incumbent) return incumbent;
        seed(create.id, create.header, create.body);
        return rows.get(create.id);
    });
    app.post('/v1/artifacts/:id', async request => {
        const row = rows.get(idOf(request.params));
        if (!row) throw new Error('artifact_missing');
        const update = z.looseObject({ header: z.string(), body: z.string(), expectedHeaderVersion: z.number(), expectedBodyVersion: z.number() }).parse(request.body);
        if (update.expectedHeaderVersion !== row.headerVersion || update.expectedBodyVersion !== row.bodyVersion) return { success: false, error: 'version-mismatch' };
        const next = { ...row, header: update.header, body: update.body, headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 };
        rows.set(row.id, next);
        return { success: true, headerVersion: next.headerVersion, bodyVersion: next.bodyVersion };
    });
    return { seed, read: (id: string) => rows.get(id) };
}
