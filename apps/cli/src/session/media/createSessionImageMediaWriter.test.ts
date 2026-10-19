import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { verifySessionStructuredImageInput, sessionMediaToStructuredImageInput } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { createSessionImageMediaWriter } from './createSessionImageMediaWriter';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

describe('createSessionImageMediaWriter', () => {
    it('persists native pixels in the selected Session artifact bucket and returns a verifiable generic reference', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'happier-session-image-'));
        try {
            const writer = createSessionImageMediaWriter({ workingDirectory: cwd, storage: 'session',
                pathAllowanceRegistry: createTransferPathAllowanceRegistry() });
            const result = await writer.write({ sessionId: 'session-1', captureId: 'capture-1', png: PNG });
            expect(result).toMatchObject({ ok: true, media: { width: 1, height: 1, sizeBytes: PNG.length,
                file: { sessionId: 'session-1', storage: 'session', mimeType: 'image/png',
                    sha256: createHash('sha256').update(PNG).digest('hex') } } });
            if (!result.ok || !result.media.file) throw new Error('Expected persisted native media');
            expect(result.media.file.path).toMatch(/^\.happier\/uploads\/artifacts\/session-1\/capture-1\//);
            expect(await readFile(join(cwd, result.media.file.path))).toEqual(PNG);
            const image = sessionMediaToStructuredImageInput(result.media);
            expect(image.provenance).toEqual({ kind: 'sessionMediaArtifact', sessionId: 'session-1', storage: 'session' });
            expect(await verifySessionStructuredImageInput({ cwd, sessionId: 'session-1', image, maxBytes: PNG.length }))
                .toMatchObject({ status: 'verified', bytes: PNG });

            const daemonWriter = createSessionImageMediaWriter({ workingDirectory: cwd, storage: 'daemon',
                pathAllowanceRegistry: createTransferPathAllowanceRegistry() });
            const daemonResult = await daemonWriter.write({ sessionId: 'session-1', captureId: 'daemon-capture', png: PNG });
            expect(daemonResult).toMatchObject({ ok: true, media: { file: { storage: 'daemon' } } });
            if (!daemonResult.ok || !daemonResult.media.file) throw new Error('Expected daemon media');
            expect(await readFile(join(cwd, daemonResult.media.file.path))).toEqual(PNG);
        } finally { await rm(cwd, { recursive: true, force: true }); }
    });

    it('refuses malformed PNG bytes and untrusted bucket identifiers', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'happier-session-image-'));
        try {
            const writer = createSessionImageMediaWriter({ workingDirectory: cwd, storage: 'session',
                pathAllowanceRegistry: createTransferPathAllowanceRegistry() });
            expect(await writer.write({ sessionId: 'session-1', captureId: 'capture-1', png: Buffer.from('not a PNG') }))
                .toMatchObject({ ok: false, reason: 'capture_failed' });
            expect(await writer.write({ sessionId: '../session-2', captureId: 'capture-1', png: PNG }))
                .toMatchObject({ ok: false, reason: 'capture_failed' });
            expect(await writer.write({ sessionId: 'session-1', captureId: '../capture-2', png: PNG }))
                .toMatchObject({ ok: false, reason: 'capture_failed' });
        } finally { await rm(cwd, { recursive: true, force: true }); }
    });
});
