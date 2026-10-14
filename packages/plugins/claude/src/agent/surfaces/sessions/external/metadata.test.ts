import { appendFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    readClaudeJsonlSessionTitle,
    readClaudeJsonlSessionTitleWithIndex,
} from './metadata.js';

function jsonlLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

describe('Claude external-session metadata', () => {
    it('scans past non-title-bearing leading records until it finds meaningful user text', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-one.jsonl');
        const meaningfulTask = 'Validate infinite scrolling for external Claude transcripts without dropping tool lines';

        const lines = [
            ...Array.from({ length: 3 }, (_, index) =>
                jsonlLine({
                    type: 'user',
                    uuid: `image-${index}`,
                    cwd: '/repo/two',
                    message: {
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: 'image/png',
                                    data: 'AAAA',
                                },
                            },
                        ],
                    },
                }),
            ),
            jsonlLine({
                type: 'user',
                uuid: 'actual-user-text',
                cwd: '/repo/two',
                message: { content: meaningfulTask },
            }),
        ];

        await writeFile(filePath, lines.join(''), 'utf8');

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBe(meaningfulTask);
    });

    it('does not substitute a queued prompt when the transcript has no immutable user message', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-queue-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-one.jsonl');
        const queuedPrompt = 'hello from queued external Claude session';

        await writeFile(
            filePath,
            [
                jsonlLine({
                    type: 'queue-operation',
                    operation: 'enqueue',
                    sessionId: 'session-one',
                    content: queuedPrompt,
                }),
                jsonlLine({
                    type: 'queue-operation',
                    operation: 'dequeue',
                    sessionId: 'session-one',
                }),
            ].join(''),
            'utf8',
        );

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBeNull();
    });

    it('matches Claude title precedence and ignores title records for another session', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-history-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            [
                jsonlLine({ type: 'user', uuid: 'first-user', message: { content: 'old first user title' } }),
                jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'AI generated title' }),
                jsonlLine({ type: 'custom-title', sessionId: 'other-session', customTitle: 'Wrong session title' }),
                jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: 'Renamed Claude session' }),
                jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'Later AI title' }),
                jsonlLine({ type: 'summary', summary: 'Mutable summary title' }),
            ].join(''),
            'utf8',
        );

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBe('Renamed Claude session');
    });

    it('finds the fallback title beyond the former bounded head', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-head-budget-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });
        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            [
                ...Array.from({ length: 64 }, (_, index) => jsonlLine({
                    type: 'user',
                    uuid: `image-${index}`,
                    message: { content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] },
                })),
                jsonlLine({ type: 'user', uuid: 'late-text', message: { content: 'must not scan this far' } }),
            ].join(''),
            'utf8',
        );

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBe('must not scan this far');
    });

    it('resumes from persisted scan state and applies later custom-title clearing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-index-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });
        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            jsonlLine({
                type: 'user',
                uuid: 'first-user',
                message: { content: 'First meaningful user text' },
            }),
            'utf8',
        );

        const first = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
        });
        expect(first.title).toBe('First meaningful user text');
        expect(first.indexState.verifiedThroughBytes).toBeGreaterThan(0);

        await appendFile(
            filePath,
            jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'Latest AI title' }),
            'utf8',
        );
        const withAi = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: first.indexState,
        });
        expect(withAi.title).toBe('Latest AI title');
        expect(withAi.indexState.verifiedThroughBytes).toBeGreaterThan(
            first.indexState.verifiedThroughBytes,
        );

        await appendFile(
            filePath,
            jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: 'Manual title' }),
            'utf8',
        );
        const withCustom = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: withAi.indexState,
        });
        expect(withCustom.title).toBe('Manual title');

        await appendFile(
            filePath,
            jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'Later AI title' }),
            'utf8',
        );
        const withLaterAi = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: withCustom.indexState,
        });
        expect(withLaterAi).toMatchObject({
            title: 'Manual title',
            indexState: { customTitle: 'Manual title', aiTitle: 'Later AI title' },
        });
        expect(withLaterAi.indexState.verifiedThroughBytes).toBeGreaterThan(
            withCustom.indexState.verifiedThroughBytes,
        );

        await appendFile(
            filePath,
            [
                jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: '   ' }),
            ].join(''),
            'utf8',
        );
        await expect(readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: withLaterAi.indexState,
        })).resolves.toMatchObject({
            title: 'Later AI title',
            indexState: {
                customTitle: null,
                aiTitle: 'Later AI title',
                fallbackTitle: 'First meaningful user text',
            },
        });
    });

    it('does not checkpoint past an incomplete final title record', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-partial-tail-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });
        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            [
                jsonlLine({
                    type: 'user',
                    uuid: 'first-user',
                    message: { content: 'Fallback title' },
                }),
                '{"type":"custom-title","sessionId":"session-one","customTitle":"Part',
            ].join(''),
            'utf8',
        );

        const partial = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
        });
        expect(partial.title).toBe('Fallback title');
        expect(partial.indexState.verifiedThroughBytes).toBeLessThan(
            (await stat(filePath)).size,
        );

        await appendFile(filePath, 'ial"}\n', 'utf8');
        await expect(readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: partial.indexState,
        })).resolves.toMatchObject({ title: 'Partial' });
    });
});
