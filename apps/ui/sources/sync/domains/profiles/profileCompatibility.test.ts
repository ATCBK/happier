import { describe, expect, it } from 'vitest';

import { isProfileCompatibleWithBackendTarget } from './profileCompatibility';

describe('isProfileCompatibleWithBackendTarget', () => {
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
