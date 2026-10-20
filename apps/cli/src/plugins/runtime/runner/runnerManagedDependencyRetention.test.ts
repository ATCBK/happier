import { describe, expect, it } from 'vitest';

import {
    areRunnerManagedProviderRetainedAuthoritiesEqual,
    mergeRunnerManagedDependencyRetentionV1,
    RunnerManagedProviderRetainedAuthorityV1Schema,
    RunnerManagedDependencyRetentionV1Schema,
} from './runnerManagedDependencyRetention';

const bundledAuthority = Object.freeze({
    pluginId: 'acme.provider',
    sourceCustody: Object.freeze({
        kind: 'managed' as const,
        immutableGenerationId: 'provider-generation-p',
        installSource: 'npm' as const,
    }),
    manifestAuthority: 'bundled_first_party' as const,
    hardRevocationRevisionAtAdmission: 7,
});

describe('Runner managed Provider retained authority', () => {
    it.each([
        { kind: 'account_release', pluginId: 'acme.provider', version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
        { kind: 'bundled_first_party', packagedRuntime: { kind: 'app_bundle', bundleId: 'ui-bundle' } },
        { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration', packageName: '@acme/provider', declarationDigest: `sha256:${'b'.repeat(64)}` } },
    ])('refuses non-Machine executable custody in retained dependencies: $kind', (sourceCustody) => {
        expect(RunnerManagedDependencyRetentionV1Schema.safeParse({
            v: 1, sourceCustodies: [sourceCustody], qualifiedDependencyIds: [],
        }).success).toBe(false);
        expect(RunnerManagedProviderRetainedAuthorityV1Schema.safeParse({
            ...bundledAuthority, sourceCustody,
        }).success).toBe(false);
    });

    it('strictly requires and preserves the private Provider source class', () => {
        expect(
            RunnerManagedProviderRetainedAuthorityV1Schema.safeParse({
                pluginId: bundledAuthority.pluginId,
                sourceCustody: bundledAuthority.sourceCustody,
                hardRevocationRevisionAtAdmission:
                    bundledAuthority.hardRevocationRevisionAtAdmission,
            }).success,
        ).toBe(false);
        expect(
            RunnerManagedProviderRetainedAuthorityV1Schema.parse(
                bundledAuthority,
            ),
        ).toEqual(bundledAuthority);
        expect(mergeRunnerManagedDependencyRetentionV1({
            v: 1,
            adoptedManagedProviderAuthority: bundledAuthority,
            sourceCustodies: [],
            qualifiedDependencyIds: [],
        }).adoptedManagedProviderAuthority).toEqual(bundledAuthority);
    });

    it('treats differing Provider source classes as different authorities', () => {
        expect(areRunnerManagedProviderRetainedAuthoritiesEqual(
            bundledAuthority,
            {
                ...bundledAuthority,
                manifestAuthority: 'external',
            },
        )).toBe(false);
        expect(() => mergeRunnerManagedDependencyRetentionV1(
            {
                v: 1,
                adoptedManagedProviderAuthority: bundledAuthority,
                sourceCustodies: [],
                qualifiedDependencyIds: [],
            },
            {
                v: 1,
                adoptedManagedProviderAuthority: {
                    ...bundledAuthority,
                    sourceCustody: {
                        kind: 'bundled_first_party',
                        packagedRuntime: {
                            kind: 'pinned_runner_snapshot',
                            snapshotId: 'provider-generation-p',
                        },
                    },
                    manifestAuthority: 'external',
                },
                sourceCustodies: [],
                qualifiedDependencyIds: [],
            },
        )).toThrow(
            'Runner retention cannot merge competing adopted Provider authorities',
        );
    });
});
