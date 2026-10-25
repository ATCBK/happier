import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
    deriveSessionContentAvailability,
    isSessionContentReadable,
    readBlockedSessionContentAvailability,
    readSessionContentAvailability,
} from './encryptedContentAvailability';

describe('deriveSessionContentAvailability', () => {
    it('reads plain, opened and owner-compatibility Sessions as ready', () => {
        expect(deriveSessionContentAvailability({
            hydrationState: 'not_required',
        })).toBe('ready');
        expect(deriveSessionContentAvailability({
            hydrationState: 'ready',
        })).toBe('ready');
        expect(deriveSessionContentAvailability({
            hydrationState: 'legacy_fallback_ready',
        })).toBe('ready');
    });

    it('waits for encrypted access when the recipient Account can receive keys', () => {
        expect(deriveSessionContentAvailability({
            hydrationState: 'missing_envelope',
            recipientReadiness: { status: 'available' },
        })).toBe('encrypted_access_pending');
    });

    it('sends a keyless or recoverable Account to setup rather than repair', () => {
        expect(deriveSessionContentAvailability({
            hydrationState: 'missing_envelope',
            recipientReadiness: { status: 'unavailable', reason: 'plain_account' },
        })).toBe('recipient_encryption_setup_required');
        expect(deriveSessionContentAvailability({
            hydrationState: 'missing_envelope',
            recipientReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
        })).toBe('recipient_encryption_setup_required');
    });

    it('sends an inconsistent Account binding to repair', () => {
        expect(deriveSessionContentAvailability({
            hydrationState: 'missing_envelope',
            recipientReadiness: { status: 'unavailable', reason: 'encryption_inconsistent' },
        })).toBe('encrypted_access_needs_repair');
    });

    it('waits rather than accusing the Account when readiness is not yet known', () => {
        expect(deriveSessionContentAvailability({
            hydrationState: 'missing_envelope',
        })).toBe('encrypted_access_pending');
    });

    it('treats an unopenable envelope as repair regardless of Account readiness', () => {
        expect(deriveSessionContentAvailability({
            hydrationState: 'unopenable_envelope',
            recipientReadiness: { status: 'available' },
        })).toBe('encrypted_access_needs_repair');
        expect(deriveSessionContentAvailability({
            hydrationState: 'unopenable_envelope',
            recipientReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
        })).toBe('encrypted_access_needs_repair');
    });

    /**
     * The server cannot tell a structurally valid but cryptographically wrong envelope from a
     * correct one, and content that fails authentication after a successful open is not an
     * envelope problem. Reporting repair there would loop the user through a ceremony that
     * cannot help.
     */
    it('reports unavailable content when authentication fails after the key opened', () => {
        expect(deriveSessionContentAvailability({
            hydrationState: 'ready',
            contentAuthenticationFailed: true,
        })).toBe('encrypted_content_unavailable');
        expect(deriveSessionContentAvailability({
            hydrationState: 'legacy_fallback_ready',
            contentAuthenticationFailed: true,
        })).toBe('encrypted_content_unavailable');
    });

    it('keeps a key-delivery failure distinct from a content failure', () => {
        expect(deriveSessionContentAvailability({
            hydrationState: 'unopenable_envelope',
            contentAuthenticationFailed: true,
        })).toBe('encrypted_access_needs_repair');
    });

    it('reports only ready as readable content', () => {
        expect(isSessionContentReadable('ready')).toBe(true);
        expect(isSessionContentReadable('encrypted_access_pending')).toBe(false);
        expect(isSessionContentReadable('recipient_encryption_setup_required')).toBe(false);
        expect(isSessionContentReadable('encrypted_access_needs_repair')).toBe(false);
        expect(isSessionContentReadable('encrypted_content_unavailable')).toBe(false);
    });
    it('reports unsettled content as neither readable nor blocked', () => {
        expect(isSessionContentReadable(null)).toBe(false);
        expect(readBlockedSessionContentAvailability(null)).toBeNull();
        expect(readBlockedSessionContentAvailability('ready')).toBeNull();
        expect(readBlockedSessionContentAvailability('encrypted_access_pending')).toBe('encrypted_access_pending');
    });
});

describe('readSessionContentAvailability', () => {
    it('defaults plain content to ready but honors a settled owner-metadata lock', () => {
        expect(readSessionContentAvailability({ encryptionMode: 'plain' })).toBe('ready');
        expect(readSessionContentAvailability({ encryptionMode: 'plain', encryptedContentAvailability: null })).toBe('ready');
        expect(readSessionContentAvailability({
            encryptionMode: 'plain',
            encryptedContentAvailability: 'encrypted_content_unavailable',
        })).toBe('encrypted_content_unavailable');
    });

    it('returns the settled fact of an encrypted Session', () => {
        expect(readSessionContentAvailability({
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable',
        })).toBe('encrypted_content_unavailable');
        expect(readSessionContentAvailability({ encryptionMode: 'e2ee', encryptedContentAvailability: 'ready' })).toBe('ready');
    });

    it('reads an absent fact as unsettled, with or without a known mode', () => {
        expect(readSessionContentAvailability({ encryptionMode: 'e2ee' })).toBeNull();
        expect(readSessionContentAvailability({})).toBeNull();
        expect(readSessionContentAvailability({ encryptedContentAvailability: 'ready' })).toBe('ready');
    });
});

/**
 * Four surfaces once decided "locked" with four predicates that disagreed on an unset fact. Every
 * decision now goes through the reader above; this fails when a surface compares the raw field again.
 * Writers (assignments, projections that copy the field) are not decisions and are not matched.
 */
describe('content availability decision sites', () => {
    const sourcesRoot = resolve(__dirname, '../../..');
    const owner = 'sync/domains/session/encryptedContentAvailability.ts';
    const rawDecision = /encryptedContentAvailability\s*(?:===|!==|&&|\?(?![?.:])|\)\s*(?:===|!==))|(?:===|!==)\s*[\w.?]*encryptedContentAvailability\b|(?:if|while)\s*\(\s*!?[\w.?]*encryptedContentAvailability\s*\)|switch\s*\([\w.?]*encryptedContentAvailability\)/;
    // Writers that compare only to copy the fact or to skip a redundant write of it.
    const allowedWriters = new Set([
        'sync/domains/state/warmCacheAdapters.ts',
        'sync/syncEngine.ts',
        'sync/engine/sessions/sessionSnapshot.ts',
        'sync/domains/session/listing/sessionListRenderable.ts',
        'sync/domains/session/listing/sessionListRenderableSessionProjection.ts',
        // Retains an unchanged Session option by comparing its copied facts (254852ff45).
        'components/workflows/screens/useWorkflowExistingSessionOptions.ts',
    ]);

    function listSources(dir: string): string[] {
        const files: string[] = [];
        for (const entry of readdirSync(dir)) {
            if (entry === 'node_modules' || entry.startsWith('.')) continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) files.push(...listSources(full));
            else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) files.push(full);
        }
        return files;
    }

    it('has no second reader of the raw fact', () => {
        const offenders = listSources(sourcesRoot)
            .map((file) => relative(sourcesRoot, file).split('\\').join('/'))
            .filter((file) => file !== owner && !allowedWriters.has(file))
            .filter((file) => rawDecision.test(readFileSync(join(sourcesRoot, file), 'utf8')));
        expect(offenders).toEqual([]);
    });
});
