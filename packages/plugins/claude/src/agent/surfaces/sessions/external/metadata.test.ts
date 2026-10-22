import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    applyClaudeTitleRecord,
    resolveClaudeTitle,
    readClaudeJsonlSessionTitle,
    readClaudeJsonlSessionWorkingDirectory,
    readClaudeJsonlSessionTitleWithIndex,
} from './metadata.js';
import { buildHappierBaseSystemPromptV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';
import { renderSessionInputContextPromptV1, renderSessionInputContextBlockV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';

function jsonlLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

describe('Claude external-session metadata', () => {
    it('retains optional working-directory fallback when a native row exceeds the read allowance', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-large-cwd-'));
        try {
            const projectDir = join(root, 'projects', 'proj-one');
            await mkdir(projectDir, { recursive: true });
            await writeFile(join(projectDir, 'large-row.jsonl'), jsonlLine({ type: 'assistant', data: 'x'.repeat(9 * 1024 * 1024) }));
            await expect(readClaudeJsonlSessionWorkingDirectory({ source: { kind: 'claudeConfig', configDir: root }, remoteSessionId: 'large-row', env: { CLAUDE_CONFIG_DIR: root } }))
                .resolves.toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it('re-derives an unchanged native title when the stored fallback still contains an injected-only first turn', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-old-title-'));
        try {
            const filePath = join(root, 'native-1.jsonl');
            const prefix = buildHappierBaseSystemPromptV1();
            await writeFile(filePath, [
                { type: 'user', message: { content: prefix } },
                { type: 'user', message: { content: 'Review the release branch' } },
            ].map(jsonlLine).join(''));
            const current = await readClaudeJsonlSessionTitleWithIndex({ filePath, remoteSessionId: 'native-1' });
            // The previous reader normalized the first user record verbatim into this
            // opaque v1 checkpoint; its physical source/EOF evidence is still current.
            const previousState = { ...current.indexState, fallbackTitle: prefix.replace(/\s+/g, ' ').trim() };
            expect((await readClaudeJsonlSessionTitleWithIndex({ filePath, remoteSessionId: 'native-1', previousState })).title)
                .toBe('Review the release branch');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it('derives a real user title from a native prompt echo and retains native title precedence', () => {
        const content = `${buildHappierBaseSystemPromptV1()}\n\nStabilise CI on the release branch`;
        const variable = renderSessionInputContextPromptV1({
            provenanceBlock: renderSessionInputContextBlockV1({ provenance: { v: 1, kind: 'legacyUnknown' } }),
            transformedUserText: `${buildHappierBaseSystemPromptV1()}\n\nStabilise CI on the release branch`,
        });
        expect(resolveClaudeTitle(applyClaudeTitleRecord({ customTitle: null, aiTitle: null, fallbackTitle: null },
            { type: 'user', message: { content: variable } }, 'native-variable'))).toContain('happier_input_context');
        const fallback = applyClaudeTitleRecord({ customTitle: null, aiTitle: null, fallbackTitle: null },
            { type: 'user', message: { content } }, 'native-1');
        expect(resolveClaudeTitle(fallback)).toBe('Stabilise CI on the release branch');
        expect(resolveClaudeTitle(applyClaudeTitleRecord(fallback,
            { type: 'custom-title', sessionId: 'native-1', customTitle: 'My explicit title' }, 'native-1'))).toBe('My explicit title');
    });
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
