import { describe, expect, it } from 'vitest';

import { buildCustomProviderTemplate, createCustomProviderDraft, createCustomProviderDraftFromTemplate, updateCustomProviderDraftAdvanced, updateCustomProviderDraftPreset } from './state';

describe('custom provider authoring state', () => {
    it('builds an OpenAI-compatible probe template through the canonical normalizer', () => {
        const draft = createCustomProviderDraft('openai-responses');
        const template = buildCustomProviderTemplate({
            ...draft,
            name: 'Company gateway',
            baseUrl: 'https://gateway.example.test/v1',
        });

        expect(template.endpointTemplates[0]).toMatchObject({
            protocol: 'openai-responses',
            baseUrl: 'https://gateway.example.test/v1',
        });
        expect(template.catalog).toMatchObject({ source: 'probe' });
        expect(template.credential?.transports[0]?.destination).toEqual({
            kind: 'httpHeader',
            name: 'authorization',
            format: 'bearer',
        });
    });

    it('probes Anthropic-compatible providers with x-api-key by default', () => {
        const draft = createCustomProviderDraft('anthropic');
        const template = buildCustomProviderTemplate({
            ...draft,
            name: 'Anthropic gateway',
            baseUrl: 'https://gateway.example.test/anthropic',
        });

        expect(draft.endpoints.find((endpoint) => endpoint.protocol === 'anthropic')).toMatchObject({
            probePathsText: '/v1/models?limit=1000',
            probeParser: 'anthropic-models',
            publicHeadersText: 'anthropic-version: 2023-06-01',
        });

        expect(template.catalog).toEqual({
            source: 'probe',
            manualModelPolicy: 'allowed',
            probes: [{
                endpointTemplateId: 'anthropic',
                path: '/v1/models?limit=1000',
                parser: 'anthropic-models',
            }],
        });
        expect(template.credential?.transports[0]?.destination).toEqual({
            kind: 'httpHeader',
            name: 'x-api-key',
            format: 'raw',
        });
    });

    it('removes credential materialization when no API key is selected', () => {
        const template = buildCustomProviderTemplate({
            ...createCustomProviderDraft('openai-chat'),
            name: 'Local gateway',
            baseUrl: 'http://127.0.0.1:8080/v1',
            requiresApiKey: false,
        });
        expect(template.credential).toBeUndefined();
    });

    it('resets only protocol-owned defaults when changing preset', () => {
        const original = {
            ...createCustomProviderDraft('openai-chat'),
            name: 'Keep me',
            baseUrl: 'https://gateway.example.test',
        };
        expect(updateCustomProviderDraftPreset(original, 'anthropic')).toMatchObject({
            name: 'Keep me',
            baseUrl: 'https://gateway.example.test',
            protocol: 'anthropic',
            catalog: 'probe',
            modelsPath: '/v1/models?limit=1000',
            credentialStyle: 'x-api-key',
        });
    });

    it('builds a multi-protocol advanced template with public headers and one safe probe per endpoint', () => {
        const draft = createCustomProviderDraft('openai-responses');
        const template = buildCustomProviderTemplate({
            ...draft,
            name: 'Advanced gateway',
            advanced: true,
            endpoints: [
                {
                    protocol: 'openai-responses', enabled: true, baseUrl: 'https://gateway.example/v1',
                    requiresApiKey: true, credentialStyle: 'bearer', credentialHeader: '',
                    publicHeadersText: 'X-Tenant: engineering', probePathsText: '/models\n/fallback-models',
                    probeParser: 'openai-models',
                },
                {
                    protocol: 'anthropic', enabled: true, baseUrl: 'https://gateway.example/anthropic',
                    requiresApiKey: true, credentialStyle: 'x-api-key', credentialHeader: '',
                    publicHeadersText: '', probePathsText: '/model-catalog',
                    probeParser: 'openai-models',
                },
            ],
        });
        expect(template.endpointTemplates).toMatchObject([
            { protocol: 'openai-responses', publicHeaders: { 'x-tenant': 'engineering' } },
            { protocol: 'anthropic' },
        ]);
        expect(template.catalog).toMatchObject({ source: 'probe', probes: [
            { endpointTemplateId: 'openai-responses', path: '/models' },
            { endpointTemplateId: 'openai-responses', path: '/fallback-models' },
            { endpointTemplateId: 'anthropic', path: '/model-catalog' },
        ] });
    });

    it('retains custom credential transport and manual catalog through presentation changes', () => {
        const simple: ReturnType<typeof createCustomProviderDraft> = {
            ...createCustomProviderDraft('openai-chat'), name: 'Gateway', baseUrl: 'https://gateway.example.test/v1',
            credentialStyle: 'custom-header', credentialHeader: 'X-Gateway-Key', catalog: 'manual',
        };
        const advanced = updateCustomProviderDraftAdvanced(simple, true);
        expect(buildCustomProviderTemplate(advanced)).toMatchObject({
            credential: { transports: [{ destination: { kind: 'httpHeader', name: 'x-gateway-key', format: 'raw' } }] },
            catalog: { source: 'manual' },
        });
        expect(buildCustomProviderTemplate(updateCustomProviderDraftAdvanced(advanced, false))).toEqual(buildCustomProviderTemplate(simple));
    });

    describe('editing a saved custom template (F08)', () => {
        const roundTrip = (draft: Parameters<typeof buildCustomProviderTemplate>[0]) => {
            const template = buildCustomProviderTemplate(draft);
            const reopened = createCustomProviderDraftFromTemplate(template);
            expect(reopened).not.toBeNull();
            return { template, reopened: reopened!, rebuilt: buildCustomProviderTemplate(reopened!) };
        };

        it('reopens a simple template in the simple form and saves it back unchanged', () => {
            for (const draft of [
                { ...createCustomProviderDraft('openai-responses'), name: 'Gateway', baseUrl: 'https://gw.example.test/v1' },
                { ...createCustomProviderDraft('anthropic'), name: 'Claude proxy', baseUrl: 'https://proxy.example.test' },
                { ...createCustomProviderDraft('openai-chat'), name: 'Local', baseUrl: 'http://127.0.0.1:1234/v1',
                    requiresApiKey: false, catalog: 'manual' as const },
                { ...createCustomProviderDraft('openai-chat'), name: 'Header', baseUrl: 'https://h.example.test/v1',
                    credentialStyle: 'custom-header-bearer' as const, credentialHeader: 'X-Gateway-Key' },
            ]) {
                const { template, reopened, rebuilt } = roundTrip(draft);
                expect(reopened.advanced).toBe(false);
                expect(reopened).toMatchObject({ name: draft.name, protocol: draft.protocol,
                    baseUrl: template.endpointTemplates[0]!.baseUrl,
                    requiresApiKey: draft.requiresApiKey, catalog: draft.catalog });
                expect(rebuilt).toEqual(template);
            }
        });

        it('reopens a multi-endpoint template in the advanced form and saves it back unchanged', () => {
            const advanced = updateCustomProviderDraftAdvanced({
                ...createCustomProviderDraft('openai-responses'), name: 'Multi', baseUrl: 'https://multi.example.test/v1',
            }, true);
            const { template, reopened, rebuilt } = roundTrip({
                ...advanced,
                endpoints: advanced.endpoints.map((endpoint) => endpoint.protocol === 'anthropic'
                    ? { ...endpoint, enabled: true, baseUrl: 'https://multi.example.test', credentialStyle: 'api-key' as const,
                        publicHeadersText: 'anthropic-version: 2023-06-01\nx-team: blue' }
                    : endpoint),
            });
            expect(reopened.advanced).toBe(true);
            expect(reopened.endpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => endpoint.protocol).sort())
                .toEqual(['anthropic', 'openai-responses']);
            expect(rebuilt).toEqual(template);
        });

        it('offers no form for a template the form cannot express', () => {
            const template = buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Odd', baseUrl: 'https://odd.example.test/v1',
            });
            expect(createCustomProviderDraftFromTemplate({
                ...template,
                endpointTemplates: template.endpointTemplates.map((endpoint) => ({ ...endpoint, protocol: 'ollama-native' })),
            })).toBeNull();
        });
    });
});
