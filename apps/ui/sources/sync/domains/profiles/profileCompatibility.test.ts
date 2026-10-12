import { describe, expect, it } from 'vitest';

import { isProfileCompatibleWithAgent, isProfileCompatibleWithBackendTarget } from './profileCompatibility';

describe('isProfileCompatibleWithBackendTarget', () => {
    it('keeps an unresolved stored backend key incompatible during New Session profile filtering', () => {
        const profile = { compatibility: {}, compatibilityByTargetKey: { 'backend:custom-acp': true }, isBuiltIn: false };
        expect([profile].filter(value => isProfileCompatibleWithBackendTarget(value, 'backend:custom-acp'))).toEqual([]);
    });

    it('does not hide a non-validation failure while reading a target', () => {
        const failure = new Error('Target source unavailable');
        const target = {
            kind: 'backend' as const,
            get backendId(): string { throw failure; },
        };
        expect(() => isProfileCompatibleWithBackendTarget(
            { compatibility: {}, isBuiltIn: false }, target,
        )).toThrow(failure);
    });

    it('excludes the configured Agent container from legacy Agent compatibility filters', () => {
        const profile = { compatibility: { claude: true }, isBuiltIn: true };
        expect(isProfileCompatibleWithAgent(profile, 'custom-acp')).toBe(false);
        expect(isProfileCompatibleWithAgent(profile, 'claude')).toBe(true);
    });

    it('excludes invalid retained targets instead of throwing while filtering profiles', () => {
        const profiles = [
            { compatibility: {}, isBuiltIn: false },
            { compatibility: {}, compatibilityByTargetKey: { 'agent:happier.agent.custom-acp/custom-acp': true }, isBuiltIn: true },
        ];
        // Custom ACP is a container; a stored key without a definition cannot
        // select an executable target, even with an explicit profile override.
        expect(profiles.filter((profile) => isProfileCompatibleWithBackendTarget(
            profile, 'agent:happier.agent.custom-acp/custom-acp',
        ))).toEqual([]);
        expect(profiles.filter((profile) => isProfileCompatibleWithBackendTarget(
            profile, { kind: 'builtInAgent', agentId: 'custom-acp' },
        ))).toEqual([]);
        expect(profiles.filter((profile) => isProfileCompatibleWithBackendTarget(
            profile, { kind: 'backend', backendId: 'bad:target' },
        ))).toEqual([]);
        expect(profiles.filter((profile) => isProfileCompatibleWithBackendTarget(
            profile, { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-agent' },
        ))).toEqual([profiles[0]]);
    });

    it('keeps a configured Agent definition when resolving default and legacy profile compatibility', () => {
        const target = {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
            definitionId: 'review-agent',
        } as const;

        expect(isProfileCompatibleWithBackendTarget(
            { compatibility: {}, isBuiltIn: false },
            target,
        )).toBe(true);
        // The predecessor writes this V1 target/key, not the container id.
        expect(isProfileCompatibleWithBackendTarget(
            { compatibility: {}, isBuiltIn: false },
            { kind: 'configuredAcpBackend', backendId: 'review-agent' },
        )).toBe(true);
        expect(isProfileCompatibleWithBackendTarget(
            { compatibility: {}, isBuiltIn: false },
            'acpBackend:review-agent',
        )).toBe(true);
        expect(isProfileCompatibleWithBackendTarget(
            { compatibility: {}, isBuiltIn: true },
            target,
        )).toBe(false);
        expect(isProfileCompatibleWithBackendTarget(
            { compatibility: {}, compatibilityByTargetKey: { 'acpBackend:review-agent': true }, isBuiltIn: true },
            target,
        )).toBe(true);
    });

    it('honors a released flat Agent key for its qualified persisted Agent identity', () => {
        expect(isProfileCompatibleWithBackendTarget(
            {
                compatibility: {},
                compatibilityByTargetKey: { 'agent:claude': true },
                isBuiltIn: true,
            },
            {
                kind: 'agent',
                identity: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude',
                },
            },
        )).toBe(true);
    });

    it('resolves an installed external Agent named by its canonical target key instead of failing', () => {
        // The canonical key is what every catalog, settings and Voice surface
        // publishes for an installed Agent. Reading it through the Protocol's
        // bundled-only V1 conversion threw, so a compatible profile disappeared.
        expect(isProfileCompatibleWithBackendTarget(
            { compatibility: {}, isBuiltIn: false },
            'agent:acme.agent/native',
        )).toBe(true);
        expect(isProfileCompatibleWithBackendTarget(
            { compatibility: {}, isBuiltIn: true },
            'agent:acme.agent/native',
        )).toBe(false);
    });

    it('honors an explicit canonical entry for an installed external Agent', () => {
        expect(isProfileCompatibleWithBackendTarget(
            {
                compatibility: {},
                compatibilityByTargetKey: { 'agent:acme.agent/native': false },
                isBuiltIn: false,
            },
            { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'native' } },
        )).toBe(false);
    });
});
