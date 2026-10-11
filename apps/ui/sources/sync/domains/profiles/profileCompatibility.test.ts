import { describe, expect, it } from 'vitest';

import { isProfileCompatibleWithBackendTarget } from './profileCompatibility';

describe('isProfileCompatibleWithBackendTarget', () => {
    it('retains the configured definition when reading qualified and legacy Profile compatibility', () => {
        const targets = [
            { kind: 'agent' as const, identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
            { kind: 'configuredAcpBackend' as const, backendId: 'review-bot' },
        ];
        for (const target of targets) {
            expect(isProfileCompatibleWithBackendTarget({ compatibility: {}, isBuiltIn: false }, target)).toBe(true);
            expect(isProfileCompatibleWithBackendTarget({ compatibility: {}, isBuiltIn: true,
                compatibilityByTargetKey: { 'acpBackend:review-bot': true } }, target)).toBe(true);
            expect(isProfileCompatibleWithBackendTarget({ compatibility: {}, isBuiltIn: false,
                compatibilityByTargetKey: { 'acpBackend:review-bot': false } }, target)).toBe(false);
        }
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
