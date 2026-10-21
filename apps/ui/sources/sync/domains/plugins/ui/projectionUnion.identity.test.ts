import { describe, expect, it, vi } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { PluginProjectedResourceV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { resolveAtmospherePictureCatalog } from '@/components/atmosphere/pictureCatalog';
import { EMPTY_PLUGIN_UI_PROJECTION, normalizePluginInstalledUiDeclarations } from './projection';
import { preparePluginUiProjectionOrigins } from './projectionOrigins';
import { createInstalledPluginUiProjectionPublication, createPluginUiExecutionOriginCandidatePublication, createPluginUiProjectionUnionPublication, readPluginUiContributionOrigin, readPluginUiContributionSupplies, readPluginUiExecutionOriginCandidates, readPluginUiProjectionEntryExecutionOrigin, unionPluginUiProjections, type PluginUiProjectionUnionMember } from './projectionUnion';

describe('execution-origin projection identity', () => {
    it('does not accept copied publication metadata as proof for another shallow-frozen runtime snapshot', () => {
        const source = sourceMember('copied');
        const runtime = createPluginUiProjectionUnionPublication().publish([source]).pluginUiProjection!;
        const publication = createInstalledPluginUiProjectionPublication();
        publication.publish([EMPTY_PLUGIN_UI_PROJECTION], runtime);
        const copied = { ...runtime, unknownEntriesById: { copied: { ...runtime.unknownEntriesById.copied, payload: 'new raw input' } } };
        for (const symbol of Object.getOwnPropertySymbols(runtime)) {
            const descriptor = Object.getOwnPropertyDescriptor(runtime, symbol);
            if (descriptor) Object.defineProperty(copied, symbol, descriptor);
        }
        expect(publication.publish([EMPTY_PLUGIN_UI_PROJECTION], Object.freeze(copied))?.unknownEntriesById.copied?.payload)
            .toBe('new raw input');
    });

    it('updates only the affected plugin through union, nonempty Account declarations and candidate publication', () => {
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.account', version: '1.0.0',
            displayName: 'Account', runtime: { apiVersion: 1 }, contributes: { ui: {
                renderers: [{ id: 'page', kind: 'declarative', root: { kind: 'text', text: 'Account page' } }],
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, title: 'Account page', renderer: 'page' }],
            } } });
        const account = normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(manifest), 'web', {
            id: manifest.id, displayName: 'Account', version: manifest.version, enabled: true,
            source: { kind: 'bundled', locator: '@happier-dev/account-fixture' },
        });
        const members = Array.from({ length: 11 }, (_, index) => sourceMember(`stage${index}`));
        const ids = members.map((_, index) => `acme.stage${index}`);
        const union = createPluginUiProjectionUnionPublication();
        const installed = createInstalledPluginUiProjectionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const initial = installed.publish([account], union.publish(members).pluginUiProjection)!;
        const initialFacts = candidates.publish(initial, members, ids);
        const origin = members[0]!.projection!.installedPackagesById[ids[0]!]!.executionOrigin!;
        const runtime = union.publish(members, new Map([[ids[0]!, origin]])).pluginUiProjection!;
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        try {
            const next = installed.publish([account], runtime)!;
            const facts = candidates.publish(next, members, ids);
            expect(readPluginUiContributionOrigin(next.unknownEntriesById.stage0)?.executionOrigin).toEqual(origin);
            expect(next.surfacePlacementsById).toBe(initial.surfacePlacementsById);
            expect(Object.keys(next.surfacePlacementsById)).toContain('surfacePlacement:acme.account:page');
            for (let index = 1; index < 11; index++) {
                expect(next.unknownEntriesById[`stage${index}`]).toBe(initial.unknownEntriesById[`stage${index}`]);
                expect(facts.get(ids[index]!)).toBe(initialFacts.get(ids[index]!));
            }
            expect({ runtimeFamilyScans: entries.mock.calls.filter(([value]) => value === runtime.unknownEntriesById).length,
                candidateFamilyScans: values.mock.calls.filter(([value]) => value === next.unknownEntriesById).length })
                .toEqual({ runtimeFamilyScans: 0, candidateFamilyScans: 0 });
        } finally { entries.mockRestore(); values.mockRestore(); }
    });

    it('publishes a first runtime without traversing declaration payloads that have no previous value', () => {
        const source = sourceMember('first');
        let payloadWalks = 0;
        const payload = new Proxy({ shared: { schema: { type: 'object', properties: {} } } }, {
            ownKeys(target) { payloadWalks++; return Reflect.ownKeys(target); },
        });
        const runtime = { ...source.projection!, unknownEntriesById: {
            ...source.projection!.unknownEntriesById,
            first: { ...source.projection!.unknownEntriesById.first!, payload },
        } };
        const owner = createInstalledPluginUiProjectionPublication();
        expect(owner.publish([], runtime)).toBe(runtime);
        expect(owner.getSnapshot()).toBe(runtime);
        expect(payloadWalks).toBe(0);
    });

    it('preserves the actual picture picker catalog order when a selected picture source changes', () => {
        const pluginId = 'acme.pictures';
        const alpha = sourceMember('machine-a', pluginId, 'declaration');
        const beta = sourceMember('machine-b', pluginId, 'declaration');
        const other = sourceMember('machine-a', 'acme.other', 'other');
        const picture = (id: string, source: PluginUiProjectionUnionMember, stamped = true) => ({
            id: `${id}`, pluginId: id.slice(0, id.indexOf('/')), pluginVersion: '1.0.0', occurrenceId: source.machineId,
            ...(stamped ? { executionOrigin: source.projection!.installedPackagesById[pluginId]!.executionOrigin! } : {}),
            definition: { id: id.slice(id.indexOf('/') + 1), title: id, kind: 'photo' as const,
                credit: { author: 'Fixture', source: 'Fixture', url: 'https://example.test', licence: 'CC0' },
                src: { full: 'https://example.test/full.jpg', thumb: 'https://example.test/thumb.jpg' },
                horizon: {}, focus: {}, hour: 12, grades: { light: 1, dusk: 1, night: 1 }, dark: 'night' as const, look: {} },
        });
        const members: readonly PluginUiProjectionUnionMember[] = [{ ...alpha, projection: { ...alpha.projection!, unknownEntriesById: {}, installedPackagesById: {
            ...alpha.projection!.installedPackagesById, ...other.projection!.installedPackagesById,
        }, atmospherePicturesById: { 'acme.pictures/b': picture('acme.pictures/b', alpha), 'acme.other/mid': picture('acme.other/mid', other, false) } } },
        { ...beta, projection: { ...beta.projection!, unknownEntriesById: {}, atmospherePicturesById: {
            'acme.pictures/a': picture('acme.pictures/a', beta), 'acme.pictures/b': picture('acme.pictures/b', beta),
        } } }];
        const publication = createPluginUiProjectionUnionPublication();
        const ids = (projection: Parameters<typeof resolveAtmospherePictureCatalog>[0]) => resolveAtmospherePictureCatalog(projection)
            .filter(picture => picture.id.startsWith('acme.')).map(picture => picture.id);
        for (const member of [beta, alpha, beta]) {
            const selections = new Map([[pluginId, member.projection!.installedPackagesById[pluginId]!.executionOrigin!]]);
            expect(ids(publication.publish(members, selections).pluginUiProjection))
                .toEqual(ids(unionPluginUiProjections(members, selections).pluginUiProjection));
        }
    });

    it('matches canonical Resource-only admission, aggregate metadata and removal after reports', () => {
        const pluginId = 'acme.resources';
        const alpha = sourceMember('machine-a', pluginId, 'declaration');
        const beta = sourceMember('machine-b', pluginId, 'declaration');
        const alphaOrigin = alpha.projection!.installedPackagesById[pluginId]!.executionOrigin!;
        const betaOrigin = beta.projection!.installedPackagesById[pluginId]!.executionOrigin!;
        const resource = (id: string) => PluginProjectedResourceV2Schema.parse({
            id, pluginId, resourceKind: 'asset', scope: 'global', contentType: 'application/json',
        });
        const unrelated = sourceMember('machine-a', 'acme.unrelated', 'unrelated');
        const first = { ...alpha, projection: { ...alpha.projection!, unknownEntriesById: unrelated.projection!.unknownEntriesById, resourcesById: {
            'acme.resources/b': { ...resource('b'), occurrenceId: 'machine-a', executionOrigin: alphaOrigin },
        } } };
        const second = { ...beta, projection: { ...beta.projection!, generation: 20, resourcesById: {
            'acme.resources/a': resource('a'), 'acme.resources/b': resource('b'),
        } } };
        const publication = createPluginUiProjectionUnionPublication();
        const check = (members: readonly PluginUiProjectionUnionMember[], origin: typeof alphaOrigin | null) => {
            const selections = origin ? new Map([[pluginId, origin]]) : new Map<string, typeof alphaOrigin>();
            const actual = publication.publish(members, selections);
            const expected = unionPluginUiProjections(members, selections);
            expect(actual).toEqual(expected);
        };
        check([first, second], betaOrigin);
        check([first, second], alphaOrigin);
        check([first, second], betaOrigin);
        check([first, second], null);
        check([first], alphaOrigin);
        check([first], null);
    });

    it('does not rescan candidate package inputs for selection-only member reports over an unchanged union', () => {
        const member = sourceMember('candidate');
        const projection = unionPluginUiProjections([member]).pluginUiProjection;
        const publisher = createPluginUiExecutionOriginCandidatePublication();
        const initial = publisher.publish(projection, [member], ['acme.candidate']);
        const origin = member.projection!.installedPackagesById['acme.candidate']!.executionOrigin!;
        const keys = vi.spyOn(Object, 'keys');
        try {
            for (let index = 0; index < 100; index++) {
                expect(publisher.publish(projection, [{ ...member, selectableExecutionOrigins: index % 2 ? [origin] : [] }], ['acme.candidate'])).toBe(initial);
            }
            expect(keys.mock.calls.filter(([value]) => value === member.projection!.installedPackagesById)).toHaveLength(0);
        } finally { keys.mockRestore(); }
    });

    it('updates eleven UI origin reports by affected plugin without rereading other declarations', () => {
        let active = '';
        let unrelatedReads = 0;
        const members = Array.from({ length: 11 }, (_, index) => {
            const id = `plugin${index}`;
            const source = sourceMember(id);
            const entry = new Proxy(source.projection!.unknownEntriesById[id]!, {
                get(target, key, receiver) {
                    if (active && id !== active && key === 'pluginId') unrelatedReads++;
                    return Reflect.get(target, key, receiver);
                },
            });
            return { ...source, projection: { ...source.projection!, unknownEntriesById: { [id]: entry } } };
        });
        const publication = createPluginUiProjectionUnionPublication();
        let previous = publication.publish(members);
        const selections = new Map<string, NonNullable<ReturnType<typeof readPluginUiProjectionEntryExecutionOrigin>>>();
        for (const [index, source] of members.entries()) {
            active = `plugin${index}`;
            const pluginId = `acme.${active}`;
            const origin = source.projection.installedPackagesById[pluginId]!.executionOrigin!;
            selections.set(pluginId, origin);
            const next = publication.publish(members, new Map(selections));
            expect(readPluginUiContributionOrigin(next.pluginUiProjection?.unknownEntriesById[active])?.executionOrigin).toEqual(origin);
            for (let other = 0; other < 11; other++) if (other !== index) {
                expect(next.pluginUiProjection?.unknownEntriesById[`plugin${other}`])
                    .toBe(previous.pluginUiProjection?.unknownEntriesById[`plugin${other}`]);
            }
            previous = next;
        }
        expect(unrelatedReads).toBe(0);
        active = 'all-agree';
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        try {
            for (const source of members) {
                const pluginId = Object.keys(source.projection.installedPackagesById)[0]!;
                const origin = source.projection.installedPackagesById[pluginId]!.executionOrigin!;
                const selectable = members.map(member => member === source ? { ...member, selectableExecutionOrigins: [origin] } : member);
                expect(publication.publish(selectable, new Map(selections))).toBe(previous);
            }
            expect(entries).not.toHaveBeenCalled();
            expect(values).not.toHaveBeenCalled();
        } finally { entries.mockRestore(); values.mockRestore(); }
        active = '';
        const conflicting = members.flatMap((source, index) => [source,
            sourceMember(`replica${index}`, `acme.plugin${index}`, `plugin${index}`)]);
        const pinned = publication.publish(conflicting, selections);
        const pinnedEntries = vi.spyOn(Object, 'entries');
        const pinnedValues = vi.spyOn(Object, 'values');
        try {
            for (let index = 0; index < 11; index++) {
                const reports = conflicting.map((member, memberIndex) => memberIndex === index * 2 + 1
                    ? { ...member, selectableExecutionOrigins: [member.projection!.installedPackagesById[`acme.plugin${index}`]!.executionOrigin!] }
                    : member);
                expect(publication.publish(reports, selections)).toBe(pinned);
            }
            expect(pinnedEntries).not.toHaveBeenCalled();
            expect(pinnedValues).not.toHaveBeenCalled();
        } finally { pinnedEntries.mockRestore(); pinnedValues.mockRestore(); }
    });

    it('ignores native-only selection feedback while real declaration origin changes remain current', () => {
        const source = sourceMember('first');
        const native = { serverIdentityId: 'srv_identity', sourceRef: {
            machineId: 'first', pluginId: 'acme.native', sourceCustody: { kind: 'development' as const, registeredRootId: 'native' },
        } };
        const member = { ...source, selectableExecutionOrigins: [native] };
        const publication = createPluginUiProjectionUnionPublication();
        const initial = publication.publish([member]);
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        try {
            for (let index = 0; index < 100; index++) {
                expect(publication.publish([{ ...member, selectableExecutionOrigins: index % 2 ? [native] : [] }],
                    index % 2 ? new Map([['acme.native', native]]) : new Map())).toBe(initial);
            }
            expect(entries).not.toHaveBeenCalled();
            expect(values).not.toHaveBeenCalled();
        } finally { entries.mockRestore(); values.mockRestore(); }
        const selected = source.projection!.installedPackagesById['acme.first']!.executionOrigin!;
        const changed = publication.publish([member], new Map([['acme.first', selected]]));
        expect(changed).not.toBe(initial);
        expect(readPluginUiContributionOrigin(changed.pluginUiProjection?.unknownEntriesById.first)?.executionOrigin).toEqual(selected);
    });

    it('does not rederive declarations for observedAt-only materialization reports while trust changes stay fresh', () => {
        const source = sourceMember('first');
        const materialization = PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_identity', machineId: 'first', materializationId: 'first',
            pluginId: 'acme.first', version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
            enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [],
        });
        const member = (report: typeof materialization) => ({ ...source, materializationsByPluginId: { 'acme.first': report } });
        const reports = Array.from({ length: 100 }, (_, index) => ({
            ...PluginMachineMaterializationV1Schema.parse({ ...materialization, observedAt: index + 2 }),
            // The immutable acquisition owner retains unchanged nested facts.
            uiArtifacts: materialization.uiArtifacts,
        }));
        const union = createPluginUiProjectionUnionPublication();
        const initial = union.publish([member(materialization)]);
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        const serialize = vi.spyOn(JSON, 'stringify');
        try {
            for (const report of reports) expect(union.publish([member(report)])).toBe(initial);
            expect(entries).not.toHaveBeenCalled();
            expect(values).not.toHaveBeenCalled();
            expect(serialize).not.toHaveBeenCalled();
        } finally { entries.mockRestore(); values.mockRestore(); serialize.mockRestore(); }
        const revoked = union.publish([member(PluginMachineMaterializationV1Schema.parse({ ...materialization, trustState: 'revoked' }))]);
        expect(readPluginUiContributionSupplies(revoked.pluginUiProjection?.unknownEntriesById.first)[0]?.interactionEnabled).toBe(false);
        expect(revoked).not.toBe(initial);
    });

    it('compares portable declarations without serializing them and preserves disagreement refusal', () => {
        const left = sourceMember('first', 'acme.shared', 'shared');
        const right = sourceMember('second', 'acme.shared', 'shared');
        const member = (source: PluginUiProjectionUnionMember, payload: unknown): PluginUiProjectionUnionMember => ({
            ...source,
            materializationsByPluginId: { 'acme.shared': {
                serverIdentityId: 'srv_identity', machineId: source.machineId, materializationId: source.machineId,
                pluginId: 'acme.shared', version: '1.0.0', sourceClass: 'versionedArchive', portableRelease: true,
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`, uiArtifacts: [],
                enabled: true, trustState: 'trusted', observedAt: 1,
            } },
            selectableExecutionOrigins: [source.projection!.installedPackagesById['acme.shared']!.executionOrigin!],
            projection: { ...source.projection!, installedPackagesById: {
                'acme.shared': { ...source.projection!.installedPackagesById['acme.shared']!, displayName: 'Shared' },
            }, unknownEntriesById: { shared: { ...source.projection!.unknownEntriesById.shared, payload } } },
        });
        const publication = createPluginUiProjectionUnionPublication();
        const first = member(left, { title: 'Shared', nested: { count: 1, enabled: true } });
        const second = member(right, { nested: { enabled: true, count: 1 }, title: 'Shared' });
        const serialize = vi.spyOn(JSON, 'stringify');
        try {
            const agreed = publication.publish([first, second]);
            expect(agreed.pluginUiProjection?.unknownEntriesById.shared).toMatchObject({ hostCompatibility: 'compatible' });
            expect(serialize).not.toHaveBeenCalled();
            const changed = publication.publish([first, member(right, { title: 'Changed', nested: { count: 1, enabled: true } })]);
            expect(changed.pluginUiProjection?.unknownEntriesById.shared).toMatchObject({
                hostCompatibility: 'conflict', hostOrigin: null,
                executionOrigin: undefined, occurrenceId: undefined,
            });
            expect(serialize).not.toHaveBeenCalled();
        } finally { serialize.mockRestore(); }
    });

    it('performs no scans, parsing or serialization over unchanged publications, sibling owners and snapshot reads', () => {
        const source = sourceMember('first');
        const publication = createPluginUiProjectionUnionPublication();
        const sibling = createPluginUiProjectionUnionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const members = [source];
        const ids = ['acme.first'];
        const initial = publication.publish(members);
        const other = sibling.publish([{ ...source, phase: 'retainedOffline', interactionEnabled: false }]);
        const facts = candidates.publish(initial.pluginUiProjection, members, ids);
        const iterateIds = vi.spyOn(ids, Symbol.iterator);
        try {
            for (let index = 0; index < 100; index++) expect(candidates.publish(initial.pluginUiProjection, members, ids)).toBe(facts);
            expect(iterateIds).not.toHaveBeenCalled();
        } finally { iterateIds.mockRestore(); }
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        const serialize = vi.spyOn(JSON, 'stringify');
        const parse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            for (let index = 0; index < 100; index++) {
                expect(publication.getSnapshot()).toBe(initial);
                expect(publication.publish([source], new Map())).toBe(initial);
                expect(sibling.getSnapshot()).toBe(other);
                expect(candidates.getSnapshot()).toBe(facts);
                expect(candidates.publish(initial.pluginUiProjection, [source], ['acme.first'])).toBe(facts);
            }
            expect(entries).not.toHaveBeenCalled();
            expect(values).not.toHaveBeenCalled();
            expect(serialize).not.toHaveBeenCalled();
            expect(parse).not.toHaveBeenCalled();
        } finally { entries.mockRestore(); values.mockRestore(); serialize.mockRestore(); parse.mockRestore(); }
        expect(publication.publish([]).pluginUiProjection).toBeNull();
        expect(publication.publish([source]).pluginUiProjection?.unknownEntriesById.first).toBeDefined();
    });

    it('retains unaffected candidate slices and withdraws source facts on same-generation publication', () => {
        const members = [sourceMember('first'), sourceMember('second')];
        const union = createPluginUiProjectionUnionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const ids = ['acme.first', 'acme.second'];
        const initial = candidates.publish(union.publish(members).pluginUiProjection, members, ids);
        expect(initial.get('acme.second')?.sourceCandidates[0]?.validation.kind).toBe('admitted');
        const changed = [members[0]!, { ...members[1]!, phase: 'retainedOffline' as const,
            interactionEnabled: false, unavailableReasonCode: 'plugin_machine_unreachable' }];
        const next = candidates.publish(union.publish(changed).pluginUiProjection, changed, ids);
        expect(next.get('acme.first')).toBe(initial.get('acme.first'));
        expect(next.get('acme.second')?.sourceCandidates[0]?.validation).toEqual({ kind: 'rejected', reason: 'home_unreachable' });
        expect(next.get('acme.second')).toEqual(readPluginUiExecutionOriginCandidates({
            projection: union.getSnapshot().pluginUiProjection, members: changed, pluginId: 'acme.second',
        }));
        expect(candidates.publish(null, [], ['acme.second']).get('acme.second')?.sourceCandidates).toEqual([]);
        expect(candidates.publish(null, [], []).size).toBe(0);
    });

    it('preserves unrelated declaration rows and maps when one supplying Machine changes', () => {
        const members: readonly PluginUiProjectionUnionMember[] = ['first', 'second'].map((id) => ({
            machineId: id, serverId: 'server', phase: 'current', interactionEnabled: true,
            projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
                unknownEntriesById: { [id]: { pluginId: `acme.${id}`, contributionKind: 'unknown', occurrenceId: id } } },
        }));
        const publication = createPluginUiProjectionUnionPublication();
        const initial = publication.publish(members);
        const changed = publication.publish([members[0]!, { ...members[1]!, interactionEnabled: false, phase: 'retainedOffline' }]);
        expect(changed.pluginUiProjection?.unknownEntriesById.first).toBe(initial.pluginUiProjection?.unknownEntriesById.first);
        expect(changed.pluginUiProjection?.settingsPagesById).toBe(initial.pluginUiProjection?.settingsPagesById);
        expect(readPluginUiContributionSupplies(changed.pluginUiProjection?.unknownEntriesById.second)[0])
            .toMatchObject({ interactionEnabled: false, phase: 'retainedOffline' });
    });

    it('reconciles shared immutable supply facts once when another Machine changes currentness', () => {
        const first = sourceMember('first');
        const declaration = first.projection!.unknownEntriesById.first!;
        const source = { ...first, projection: preparePluginUiProjectionOrigins({ ...first.projection!,
            unknownEntriesById: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`first-${index}`, declaration])),
        }) };
        const second = sourceMember('second');
        const publication = createPluginUiProjectionUnionPublication();
        const initial = publication.publish([source, second]);
        const firstEntry = initial.pluginUiProjection!.unknownEntriesById['first-0'];
        const custody = readPluginUiContributionSupplies(firstEntry)[0]!.sourceCustody;
        expect(custody).toEqual({ kind: 'development', registeredRootId: 'first' });
        const keys = vi.spyOn(Object, 'keys');
        let changed: ReturnType<typeof publication.publish>;
        let custodyWalks: number;
        try {
            changed = publication.publish([source, { ...second, interactionEnabled: false, phase: 'retainedOffline' }]);
            custodyWalks = keys.mock.calls.filter(([value]) => value === custody).length;
        } finally { keys.mockRestore(); }
        expect(changed.pluginUiProjection!.unknownEntriesById['first-0']).toBe(firstEntry);
        expect(readPluginUiContributionSupplies(changed.pluginUiProjection!.unknownEntriesById.second)[0])
            .toMatchObject({ interactionEnabled: false, phase: 'retainedOffline' });
        // A shared immutable source is one graph node, not one deep walk per row.
        expect(custodyWalks).toBeLessThanOrEqual(1);
    });

    it('preserves authored property names and ordering while sharing unchanged payload fields', () => {
        const source = sourceMember('first');
        const publication = createPluginUiProjectionUnionPublication();
        // JSON.parse represents an authored own __proto__ data property, unlike
        // JavaScript's special object-literal prototype syntax.
        const first: unknown = JSON.parse('{"__proto__":{"label":"safe"},"stable":{"same":true},"title":"old"}');
        const next: unknown = JSON.parse('{"__proto__":{"label":"safe"},"stable":{"same":true},"title":"new"}');
        const publish = (payload: unknown) => publication.publish([{ ...source, projection: { ...source.projection!,
            unknownEntriesById: { first: { ...source.projection!.unknownEntriesById.first, payload } } } }]).pluginUiProjection!;
        const initial = publish(first).unknownEntriesById.first!.payload;
        const changed = publish(next).unknownEntriesById.first!.payload;
        expect(changed).toEqual(next);
        expect(Object.getOwnPropertyDescriptor(changed, '__proto__')?.value).toEqual({ label: 'safe' });
        if (!changed || typeof changed !== 'object' || !initial || typeof initial !== 'object') throw new Error('Expected published payloads');
        expect(Object.keys(changed)).toEqual(['__proto__', 'stable', 'title']);
        expect(Object.getOwnPropertyDescriptor(changed, 'stable')?.value).toBe(Object.getOwnPropertyDescriptor(initial, 'stable')?.value);
    });

    it('does not promote mutable arbitrary supply facts into the producer validation proof during sharing', () => {
        const first = sourceMember('first');
        const second = sourceMember('second', 'acme.first', 'first');
        const union = createPluginUiProjectionUnionPublication();
        const mounted = createInstalledPluginUiProjectionPublication();
        const initial = union.publish([first]).pluginUiProjection!;
        const mutableCustody = { kind: 'development' as const, registeredRootId: 'first' };
        const mutableSupply = { ...readPluginUiContributionSupplies(initial.unknownEntriesById.first)[0]!, sourceCustody: mutableCustody };
        mounted.publish([], { ...initial, unknownEntriesById: {
            first: { ...initial.unknownEntriesById.first, hostSupplies: [mutableSupply] },
        } });
        const next = mounted.publish([], union.publish([first, second]).pluginUiProjection)!;
        expect(readPluginUiContributionSupplies(next.unknownEntriesById.first)).toHaveLength(2);
        mutableCustody.registeredRootId = 'changed-after-publication';
        expect(readPluginUiContributionSupplies(next.unknownEntriesById.first)[0]?.sourceCustody)
            .toEqual({ kind: 'development', registeredRootId: 'first' });
    });

    it('reads published direct and contribution origins without reparsing while raw frozen inputs still validate', () => {
        const source = sourceMember('first');
        const selected = source.projection!.installedPackagesById['acme.first']!.executionOrigin!;
        const selections = new Map([['acme.first', selected]]);
        const publication = createPluginUiProjectionUnionPublication();
        const entry = publication.publish([source], selections).pluginUiProjection!.unknownEntriesById.first;
        const direct = readPluginUiProjectionEntryExecutionOrigin(entry);
        const contribution = readPluginUiContributionOrigin(entry);
        expect(direct).toEqual(selected);
        expect(contribution).toMatchObject({ phase: 'current', interactionEnabled: true, executionOrigin: selected });
        const parse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            const directReads = Array.from({ length: 100 }, () => readPluginUiProjectionEntryExecutionOrigin(entry));
            const contributionReads = Array.from({ length: 100 }, () => readPluginUiContributionOrigin(entry));
            expect(parse.mock.calls.length).toBe(0);
            expect(directReads.every(value => value === direct)).toBe(true);
            expect(contributionReads.every(value => value === contribution)).toBe(true);
        } finally { parse.mockRestore(); }
        const withdrawn = publication.publish([{ ...source, phase: 'retainedOffline', interactionEnabled: false }], selections)
            .pluginUiProjection!.unknownEntriesById.first;
        expect(readPluginUiContributionOrigin(withdrawn)).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false });
        const withdrawnParse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            for (let index = 0; index < 100; index++) {
                readPluginUiContributionOrigin(withdrawn);
                readPluginUiProjectionEntryExecutionOrigin(withdrawn);
            }
            expect(withdrawnParse).not.toHaveBeenCalled();
        } finally { withdrawnParse.mockRestore(); }
        const custody = { kind: 'development', registeredRootId: 'raw' };
        const raw = { serverIdentityId: 'srv_identity', sourceRef: { machineId: 'first', pluginId: 'acme.first', sourceCustody: custody } };
        const arbitrary = Object.freeze({ pluginId: 'acme.first', executionOrigin: raw,
            hostOrigin: Object.freeze({ machineId: 'first', serverId: 'server', generation: 1,
                phase: 'current', interactionEnabled: true, executionOrigin: raw }) });
        expect(readPluginUiProjectionEntryExecutionOrigin(arbitrary)).not.toBeNull();
        expect(readPluginUiContributionOrigin(arbitrary)?.executionOrigin).not.toBeNull();
        custody.kind = 'invalid';
        expect(readPluginUiProjectionEntryExecutionOrigin(arbitrary)).toBeNull();
        expect(readPluginUiContributionOrigin(arbitrary)?.executionOrigin).toBeNull();
    });

    it('prepares immutable producer origins without changing input fields, ordering or raw-input validation', () => {
        const executionOrigin = { sourceRef: { sourceCustody: { registeredRootId: 'first', kind: 'development' },
            pluginId: 'acme.first', machineId: 'first' }, serverIdentityId: 'srv_identity' };
        const hostOrigin = { machineId: 'first', serverId: 'server', generation: 1,
            phase: 'current', interactionEnabled: true, executionOrigin };
        const entry = { pluginId: 'acme.first', executionOrigin, hostOrigin };
        const model = { ...EMPTY_PLUGIN_UI_PROJECTION, unknownEntriesById: { entry } };
        const prepared = preparePluginUiProjectionOrigins(model);
        expect(JSON.stringify(prepared)).toBe(JSON.stringify(model));
        expect(preparePluginUiProjectionOrigins(prepared)).toBe(prepared);
        const carrier = prepared.unknownEntriesById.entry!.executionOrigin;
        if (!carrier || typeof carrier !== 'object' || !('sourceRef' in carrier)
            || !carrier.sourceRef || typeof carrier.sourceRef !== 'object') throw new Error('Expected owned source origin');
        expect(Reflect.set(carrier.sourceRef, 'machineId', 'changed-through-carrier')).toBe(false);
        const parse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            for (let index = 0; index < 100; index++) {
                expect(readPluginUiProjectionEntryExecutionOrigin(prepared.unknownEntriesById.entry)).not.toBeNull();
                expect(readPluginUiContributionOrigin(prepared.unknownEntriesById.entry)?.phase).toBe('current');
            }
            expect(parse).not.toHaveBeenCalled();
        } finally { parse.mockRestore(); }
        executionOrigin.sourceRef.sourceCustody.registeredRootId = 'changed';
        hostOrigin.phase = 'retainedOffline';
        hostOrigin.interactionEnabled = false;
        const next = preparePluginUiProjectionOrigins(model);
        expect(readPluginUiContributionOrigin(next.unknownEntriesById.entry)).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false });
        expect(readPluginUiContributionOrigin(prepared.unknownEntriesById.entry)?.phase).toBe('current');
        executionOrigin.sourceRef.pluginId = 'other.plugin';
        expect(readPluginUiProjectionEntryExecutionOrigin(entry)).toBeNull();
        expect(readPluginUiProjectionEntryExecutionOrigin(preparePluginUiProjectionOrigins(model).unknownEntriesById.entry)).toBeNull();
    });

    it('retains unchanged facts across union publications and invalidates source withdrawal', () => {
        const pluginId = 'example.identity';
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'identity-source' };
        const origin = { serverIdentityId: 'srv_identity', sourceRef: { pluginId, machineId: 'machine', sourceCustody } };
        const source: PluginUiProjectionUnionMember = {
            machineId: 'machine', serverId: 'srv_identity', serverIdentityId: 'srv_identity', phase: 'current', interactionEnabled: true,
            projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1, installedPackagesById: {
                [pluginId]: { id: pluginId, displayName: 'Identity', version: '1.0.0', enabled: true,
                    source: { kind: 'localPath', locator: '/identity' }, occurrenceId: 'occurrence', sourceCustody, executionOrigin: origin },
            } },
        };
        const read = (member: PluginUiProjectionUnionMember, previous?: ReturnType<typeof readPluginUiExecutionOriginCandidates>) =>
            readPluginUiExecutionOriginCandidates({ pluginId, members: [member],
                projection: unionPluginUiProjections([member]).pluginUiProjection, previous });
        const initial = read(source);
        expect(initial.sourceCandidates[0]?.validation).toEqual({ kind: 'admitted' });
        const repeated = read({ ...source }, initial);
        expect(repeated).toBe(initial);
        const withdrawn = read({ ...source, phase: 'retainedOffline', interactionEnabled: false }, initial);
        expect(withdrawn).not.toBe(initial);
        expect(withdrawn.sourceCandidates[0]?.validation).toEqual({ kind: 'rejected', reason: 'stale' });
        expect(read(source, withdrawn).sourceCandidates[0]?.validation).toEqual({ kind: 'admitted' });
        const successor = { ...source, projection: { ...source.projection!, generation: 2 } };
        expect(read(successor, initial).sourceCandidates[0]?.source.generation).toBe(2);
    });
});

function sourceMember(id: string, pluginId = `acme.${id}`, localId = id): PluginUiProjectionUnionMember {
    const sourceCustody = { kind: 'development' as const, registeredRootId: id };
    const executionOrigin = { serverIdentityId: 'srv_identity', sourceRef: { machineId: id, pluginId, sourceCustody } };
    return { machineId: id, serverId: 'server', serverIdentityId: 'srv_identity', phase: 'current', interactionEnabled: true,
        projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: id, version: '1.0.0', enabled: true,
                source: { kind: 'localPath', locator: `/${id}` }, occurrenceId: id, sourceCustody, executionOrigin } },
            unknownEntriesById: { [localId]: { pluginId, contributionKind: 'unknown', occurrenceId: id, executionOrigin } } },
    };
}
