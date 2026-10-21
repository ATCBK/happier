import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writeFakeCodexAppServerScript } from '../../src/testkit/codexAppServerRemoteHarness';
import { createRunDirs } from '../../src/testkit/runDir';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import {
    gotoDomContentLoadedWithPathFallback,
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
    waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });

type RectSnapshot = Readonly<{
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}>;

type CaretSnapshot = Readonly<{
    input: RectSnapshot;
    caret: RectSnapshot;
}>;

function createFakeJwt(email: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ email })).toString('base64url');
    return `${header}.${payload}.signature`;
}

async function writeFakeCodexAuthFile(params: Readonly<{ cliHomeDir: string }>): Promise<void> {
    const codexHomeDir = resolve(join(params.cliHomeDir, '.codex'));
    await mkdir(codexHomeDir, { recursive: true });
    const idToken = createFakeJwt('agent-input-e2e-codex@example.test');
    await writeFile(
        resolve(join(codexHomeDir, 'auth.json')),
        `${JSON.stringify({
            tokens: {
                id_token: idToken,
                access_token: idToken,
            },
        }, null, 2)}\n`,
        'utf8',
    );
}

function composerEditor(page: Page): Locator {
    return page.locator('[data-testid="session-composer-input"][contenteditable="true"]:visible');
}

async function readCaretSnapshot(editor: Locator): Promise<CaretSnapshot> {
    return await editor.evaluate((element) => {
        const selection = element.ownerDocument.getSelection();
        if (!selection?.rangeCount || !selection.focusNode || !element.contains(selection.focusNode)) {
            throw new Error('Expected a selection inside the composer editor');
        }
        // The editor exposes a native DOM selection. Measure its head in window
        // coordinates, the same coordinate space as MultiTextInput.getCaretRect().
        const range = element.ownerDocument.createRange();
        range.setStart(selection.focusNode, selection.focusOffset);
        range.collapse(true);
        const caret = range.getClientRects()[0];
        if (!caret || caret.height === 0) throw new Error('Expected a measurable composer caret');
        const inputRect = element.getBoundingClientRect();

        return {
            input: {
                left: inputRect.left,
                top: inputRect.top,
                right: inputRect.right,
                bottom: inputRect.bottom,
                width: inputRect.width,
                height: inputRect.height,
            },
            caret: {
                left: caret.left,
                top: caret.top,
                right: caret.right,
                bottom: caret.bottom,
                width: caret.width,
                height: caret.height,
            },
        };
    });
}

async function visibleBoundingBox(locator: Locator, label: string): Promise<Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>> {
    const box = await locator.boundingBox();
    if (!box) {
        throw new Error(`Expected ${label} to have a visible bounding box`);
    }
    return box;
}

async function expectSlashMenuAnchoredToEditorCaret(params: Readonly<{
    page: Page;
    editor: Locator;
}>): Promise<void> {
    const menuSurface = params.page.getByTestId('agent-input-command-menu:surface');
    await expect(menuSurface).toHaveCount(1, { timeout: 60_000 });
    await expect(menuSurface).toBeVisible({ timeout: 60_000 });

    const caret = await readCaretSnapshot(params.editor);
    const menuBox = await visibleBoundingBox(menuSurface, 'agent input command menu');
    const menuBottomToCaret = Math.abs((menuBox.y + menuBox.height) - caret.caret.top);
    const menuBottomToInputTop = Math.abs((menuBox.y + menuBox.height) - caret.input.top);
    const menuLeftToCaret = Math.abs(menuBox.x - caret.caret.left);

    expect(caret.caret.top - caret.input.top).toBeGreaterThan(24);
    expect(menuBottomToCaret).toBeLessThanOrEqual(36);
    expect(menuBottomToCaret).toBeLessThan(menuBottomToInputTop);
    expect(menuLeftToCaret).toBeLessThanOrEqual(56);
}

async function selectAutocompleteSuggestion(params: Readonly<{
    page: Page;
    editor: Locator;
    query: string;
    optionTestId: string;
    expectedValue: RegExp;
    expectedChip?: RegExp;
}>): Promise<void> {
    await params.editor.fill(params.query);
    const option = params.page.getByTestId(params.optionTestId);
    await expect(option).toHaveCount(1, { timeout: 120_000 });
    await params.page.keyboard.press('Enter');
    await expect(params.editor).toHaveText(params.expectedValue, { timeout: 60_000 });
    const chips = params.editor.locator('[data-composer-chip][contenteditable="false"]');
    await expect(chips).toHaveCount(params.expectedChip ? 1 : 0);
    if (params.expectedChip) await expect(chips).toHaveText(params.expectedChip);
    await expect(params.page.getByTestId('agent-input-command-menu:surface')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('UI e2e: AgentInput slash command menu', () => {
    const suiteDir = run.testDir('agent-input-slash-menu-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let daemon: StartedDaemon | null = null;
    let uiBaseUrl: string | null = null;

    test.beforeAll(async () => {
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');
        await writeFakeCodexAuthFile({ cliHomeDir });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
                HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-agent-input-slash-menu`,
                EXPO_PUBLIC_DEBUG: '1',
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('anchors the command menu to the editor caret and inserts slash, file, and skill mentions', async ({
        page,
    }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const browserDiagnostics = collectBrowserDiagnostics({ page });
        const testDir = resolve(join(suiteDir, 't1-agent-input-slash-menu'));
        await mkdir(testDir, { recursive: true });

        try {
            await page.setViewportSize({ width: 1440, height: 900 });
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 420_000);
            await waitForInitialAppUi({ page, timeoutMs: 420_000, browserDiagnostics });

            const fakeCodexAppServerPath = await writeFakeCodexAppServerScript({
                dir: testDir,
                requestLogPath: resolve(join(testDir, 'fake-codex-app-server.requests.jsonl')),
            });
            const codexHomeDir = resolve(join(cliHomeDir, '.codex'));

            daemon = await authenticateAndStartDaemon({
                page,
                testDir,
                cliHomeDir,
                serverUrl: server.baseUrl,
                uiBaseUrl,
                initialUiReadyTimeoutMs: 180_000,
                terminalConnectUrlTimeoutMs: 180_000,
                extraEnv: {
                    HOME: cliHomeDir,
                    CODEX_HOME: codexHomeDir,
                    HAPPIER_CODEX_APP_SERVER_BIN: fakeCodexAppServerPath,
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
                    HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                    HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
                    HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                    HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
                },
            });

            const repoDir = resolve(join(testDir, 'repo'));
            await initGitRepo({ repoDir });
            await writeFile(resolve(join(repoDir, 'README.md')), '# AgentInput e2e\n', 'utf8');
            execGit(repoDir, ['add', 'README.md']);
            execGit(repoDir, ['commit', '-m', 'chore: seed agent input fixture']);

            const sessionId = await spawnSessionFromDaemon({
                daemon,
                directory: repoDir,
                agent: 'codex',
                browserAccess: { page, serverUrl: server.baseUrl },
            });
            const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
            await gotoDomContentLoadedWithPathFallback(
                page,
                `${uiBaseUrl}${sessionPath}?happier_hmr=0`,
                sessionPath,
                180_000,
            );
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: sessionPath,
                targetUrl: `${uiBaseUrl}${sessionPath}?happier_hmr=0`,
                requiredTestIds: ['session-composer-input'],
                timeoutMs: 180_000,
                browserDiagnostics,
            });

            const editor = composerEditor(page);
            await expect(editor).toHaveCount(1, { timeout: 120_000 });
            await expect(editor).toBeEditable({ timeout: 120_000 });
            await editor.fill('first line with enough text\nsecond line before slash ');
            await editor.focus();
            await page.keyboard.type('/');
            await expectSlashMenuAnchoredToEditorCaret({ page, editor });

            await selectAutocompleteSuggestion({
                page,
                editor,
                query: '/go',
                optionTestId: 'agent-input-command-menu:list:command-menu-root:option:cmd-goal',
                expectedValue: /^\/goal\s*$/,
            });

            await selectAutocompleteSuggestion({
                page,
                editor,
                query: '@REA',
                optionTestId: 'agent-input-command-menu:list:command-menu-root:option:file-README.md',
                expectedValue: /^README\.md\s*$/,
                expectedChip: /^README\.md$/,
            });

            await selectAutocompleteSuggestion({
                page,
                editor,
                query: '$code',
                optionTestId: 'agent-input-command-menu:list:command-menu-root:option:skill-code-review',
                expectedValue: /^code-review\s*$/,
                expectedChip: /^code-review$/,
            });
        } catch (error) {
            throw appendBrowserDiagnostics(error, browserDiagnostics());
        }
    });
});
