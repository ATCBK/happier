import { describe, expect, it } from 'vitest';

import { buildDiscussionRouteHref, buildDiscussionsRouteHref, readAnchoredDiscussionSourceLinks, readDiscussionRouteAnchor, readDiscussionRouteDraftId } from './discussionRoutes';
import { upsertServerProfile, setServerProfileIdentityForUrl, areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { TriageEntryRefV1Schema } from '@happier-dev/protocol/tasks/entryRefV1';

describe('Discussion routes', () => {
    it('roundtrips a keyed new draft and refuses an invalid supplied identity instead of opening the singleton', () => {
        const draftId = '00000000-0000-5000-8000-000000000001';
        const href = buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: 'home' }, draftId } });
        const url = new URL(href, 'https://home.invalid');
        expect(url.searchParams.get('draftId')).toBe(draftId);
        expect(readDiscussionRouteDraftId(url.searchParams.get('draftId')!)).toBe(draftId);
        expect(readDiscussionRouteDraftId(undefined)).toBeUndefined();
        for (const invalid of ['', ' ', 'not-a-uuid', `${draftId}/other`, [draftId, draftId]]) {
            expect(readDiscussionRouteDraftId(invalid)).toBeNull();
        }
        expect(() => buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: 'home' }, draftId: 'unsupported' } })).toThrow();
    });
    it('round-trips a canonical Task anchor without turning its identity into source access or a provider URL', () => {
        const anchor = { kind: 'task' as const, entry: TriageEntryRefV1Schema.parse({ source: { pluginId: 'acme.tasks', localId: 'issues' },
            kindId: 'issue', collisionScope: 'project', entryId: 'task/42' }) };
        const href = buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: 'task-home' }, anchor } });
        const url = new URL(href, 'https://home.invalid');
        expect(url.pathname).toBe('/discussions/new');
        expect(url.searchParams.get('serverId')).toBe('task-home');
        expect(readDiscussionRouteAnchor({ serverId: 'task-home', anchor: url.searchParams.get('anchor') })).toEqual(anchor);
        expect(readDiscussionRouteAnchor({ serverId: null, anchor: JSON.stringify(anchor) })).toBeNull();
        expect(readDiscussionRouteAnchor({ serverId: 'task-home', anchor: JSON.stringify({ ...anchor,
            entry: { ...anchor.entry, providerUrl: 'https://tracker.invalid/42' } }) })).toBeNull();
        expect(readDiscussionRouteAnchor({ serverId: 'task-home', anchor: JSON.stringify(anchor), anchorSessionId: 'session' })).toBeNull();
    });
    it('retains a Doc captured before its Home adopted a portable identity', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://doc-anchor-alias.test', name: 'Doc Home' });
        const anchor = { kind: 'doc' as const, doc: { ref: { kind: 'doc' as const, artifactId: 'doc', serverId: profile.id },
            revision: { headerVersion: 1, bodyVersion: 2 } } };
        const portableHome = 'srv_doc_anchor_home';
        await setServerProfileIdentityForUrl(profile.serverUrl, portableHome);
        expect(areServerProfileIdentifiersEquivalent(profile.id, portableHome)).toBe(true);
        const href = buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: portableHome }, anchor } });
        const url = new URL(href, 'https://home.invalid');
        expect(url.searchParams.get('serverId')).toBe(portableHome);
        expect(readDiscussionRouteAnchor({ serverId: portableHome, anchor: url.searchParams.get('anchor') })).toEqual(anchor);
        expect(readDiscussionRouteAnchor({ serverId: 'srv_other_doc_home', anchor: url.searchParams.get('anchor') })).toBeNull();
    });
    it('projects source markers only from actual Home-qualified anchored Discussions', () => {
        const source = { kind: 'session' as const, session: { serverId: 'home-a', sessionId: 'source' }, messageId: 'answer' };
        const discussions = [
            { id: 'matching', anchor: { kind: 'session' as const, sessionId: 'source', messageId: 'answer' } },
            { id: 'other-answer', anchor: { kind: 'session' as const, sessionId: 'source', messageId: 'different' } },
            { id: 'no-anchor', anchor: null },
        ];
        expect(readAnchoredDiscussionSourceLinks({ address: { serverId: 'home-b' }, source, discussions })).toEqual([]);
        expect(readAnchoredDiscussionSourceLinks({ address: { serverId: 'home-a' }, source, discussions })).toEqual([
            { discussion: { serverId: 'home-a', discussionId: 'matching' }, source,
                href: '/discussions/matching?serverId=home-a&sourceSurface=collaboration' },
        ]);
    });

    it('opens a Home list and a new Discussion without a Session', () => {
        expect(buildDiscussionsRouteHref({ serverId: 'home-b' })).toBe('/discussions?serverId=home-b');
        expect(buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: 'home-b' } } }))
            .toBe('/discussions/new?serverId=home-b');
    });

    it('keeps the exact Home and encodes the independent Discussion identity', () => {
        for (const serverId of ['home-a', 'home-b']) {
            expect(buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId }, discussionId: 'a/b' } }))
                .toBe(`/discussions/a%2Fb?serverId=${serverId}`);
        }
    });

    it('retains the exact committed root when opening a passage thread', () => {
        expect(buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: 'saved-home' },
            discussionId: 'same-thread', messageId: 'saved-root' } }))
            .toBe('/discussions/same-thread?serverId=saved-home&messageId=saved-root');
    });

    it('keeps a new Doc anchor in the captured Home without serializing passage content', () => {
        const anchor = { kind: 'doc' as const, doc: { ref: { kind: 'doc' as const, artifactId: 'doc/a', serverId: 'saved-home' },
            revision: { headerVersion: 2, bodyVersion: 3 } } };
        const href = buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: 'saved-home' }, anchor } });
        const url = new URL(href, 'https://home.invalid');
        expect(url.pathname).toBe('/discussions/new');
        expect(url.searchParams.get('serverId')).toBe('saved-home');
        expect(JSON.parse(url.searchParams.get('anchor') ?? 'null')).toEqual(anchor);
        expect(url.searchParams.has('anchorSessionId')).toBe(false);
        expect(readDiscussionRouteAnchor({ serverId: 'saved-home', anchor: url.searchParams.get('anchor') })).toEqual(anchor);
        expect(readDiscussionRouteAnchor({ serverId: 'other-home', anchor: url.searchParams.get('anchor') })).toBeNull();
        expect(() => buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: 'other-home' }, anchor } }))
            .toThrow('server_target_mismatch');
        for (const invalid of [JSON.stringify({ ...anchor, quote: 'private source' }), JSON.stringify({ ...anchor,
            doc: { ...anchor.doc, range: { start: 0, end: 1 } } }), '{broken']) {
            expect(readDiscussionRouteAnchor({ serverId: 'saved-home', anchor: invalid })).toBeNull();
        }
        expect(readDiscussionRouteAnchor({ serverId: 'saved-home', anchor: JSON.stringify(anchor), anchorSessionId: 'other-source' })).toBeNull();
        expect(readDiscussionRouteAnchor({ serverId: 'saved-home' })).toBeUndefined();
    });

    it('carries an optional source for creation without making it part of the resource route', () => {
        expect(buildDiscussionRouteHref({
            target: { kind: 'new', address: { serverId: 'home-b' }, anchor: { kind: 'session', sessionId: 'source-a', messageId: 'message-a' } },
            sourceSurface: 'collaboration',
        })).toBe('/discussions/new?serverId=home-b&sourceSurface=collaboration&anchorSessionId=source-a&anchorMessageId=message-a');
    });
});
