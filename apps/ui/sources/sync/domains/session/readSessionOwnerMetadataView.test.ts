import { describe, expect, it } from 'vitest';
import { createSessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import {
    readSessionOwnerMetadataView,
    readSessionOwnerMetadataViewPreferences,
    resolveSessionOwnerMetadataViewRead,
} from './readSessionOwnerMetadataView';

const METADATA = Object.freeze({ path: '/Users/tester/project', host: 'tester.local' });

describe('readSessionOwnerMetadataViewPreferences', () => {
    it('reads preferences emitted by the canonical owner-metadata producer', () => {
        const created = createSessionOwnerMetadataV1({ metadata: { ...METADATA,
            work: { viewPreferences: { showToolCalls: false } } } });
        if (!created.ok) throw new Error('Expected valid owner metadata');
        expect(readSessionOwnerMetadataViewPreferences(created.ownerMetadata)).toEqual({ showToolCalls: false });
    });
    it.each([0, 1])('reads known preferences from layout %s without changing retained plugin work', layout => {
        const work = { viewPreferences: { showToolCalls: false, futurePreference: true }, pluginWork: { retained: true } };
        const owner = { ...METADATA, work };
        const view = readSessionOwnerMetadataView({ metadataLayoutVersion: layout,
            metadata: { ...METADATA, work: { viewPreferences: { showToolCalls: true } } },
            ownerMetadataView: owner });
        const expected = layout === 0 ? true : false;
        expect(readSessionOwnerMetadataViewPreferences(view)).toEqual({ showToolCalls: expected });
        expect(owner.work).toBe(work);
        expect(owner.work.pluginWork).toEqual({ retained: true });
    });

    it.each([undefined, null, 4, [], { viewPreferences: true }, { viewPreferences: { showToolCalls: 'yes' } }])(
        'leaves malformed or absent work preferences unset (%j)', work => {
            expect(readSessionOwnerMetadataViewPreferences({ ...METADATA, work })).toBeNull();
        },
    );

    it('does not recover preferences from an unavailable or unsupported owner projection', () => {
        const metadata = { ...METADATA, work: { viewPreferences: { showToolCalls: true } } };
        for (const session of [
            { metadataLayoutVersion: 1, metadata, ownerMetadataView: null },
            { metadataLayoutVersion: 2, metadata, ownerMetadataView: metadata },
        ]) expect(readSessionOwnerMetadataViewPreferences(readSessionOwnerMetadataView(session))).toBeNull();
    });
});

describe('resolveSessionOwnerMetadataViewRead', () => {
    it('respects an explicitly unavailable legacy owner view without treating bounded input as full metadata', () => {
        expect(resolveSessionOwnerMetadataViewRead({ metadataLayoutVersion: 0, metadata: METADATA, ownerMetadataView: null }))
            .toEqual({ kind: 'not_projected' });
        expect(readSessionOwnerMetadataView({ metadataLayoutVersion: 0, metadata: METADATA, ownerMetadataView: null })).toBeNull();
        expect(readSessionOwnerMetadataView({ metadataLayoutVersion: 0, metadata: METADATA })).toBe(METADATA);
    });
    it('separates a not-yet-projected owner view from a layout this build cannot read', () => {
        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: 1,
            metadata: METADATA,
            ownerMetadataView: null,
        })).toEqual({ kind: 'not_projected' });

        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: 2,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toEqual({ kind: 'unsupported_layout_version' });

        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: null as never,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toEqual({ kind: 'unsupported_layout_version' });
    });

    it('reads the layout-appropriate owner view when one is available', () => {
        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: 1,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toEqual({ kind: 'available', metadata: METADATA });

        expect(resolveSessionOwnerMetadataViewRead({
            metadata: METADATA,
        })).toEqual({ kind: 'available', metadata: METADATA });

        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: 0,
            metadata: null,
        })).toEqual({ kind: 'not_projected' });
    });

    it('keeps the existing view projection collapsing every unreadable cause to null', () => {
        expect(readSessionOwnerMetadataView({
            metadataLayoutVersion: 1,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toBe(METADATA);
        expect(readSessionOwnerMetadataView({
            metadataLayoutVersion: 1,
            metadata: METADATA,
            ownerMetadataView: null,
        })).toBeNull();
        expect(readSessionOwnerMetadataView({
            metadataLayoutVersion: 2,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toBeNull();
    });
});
