import { chromium, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';

/**
 * EDITOR-FIDELITY: the owner's two workflows (a habit with an Agent step and a quiet Notify me, and the
 * built-in Keep going until done) in the real editor, measured the way a browser lays them out.
 */
let script: string;
let origin: string;
const server = createWorkspaceBrowserServer(() => script);
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser({ entryFile: 'sources/dev/testkit/render/workflowEditorDesignBrowserApp.tsx' });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Editor browser harness did not bind');
    origin = `http://127.0.0.1:${address.port}`;
}, Number(process.env.EDITOR_FIDELITY_BUILD_TIMEOUT_MS ?? 600_000));
afterAll(async () => {
    try {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { script = ''; }
});

type State = 'habit' | 'keep-going' | 'release' | 'pristine' | 'review-builtin' | 'plan';
const BUILTIN_STATES: readonly State[] = ['keep-going', 'review-builtin', 'plan'];
type Harness = { editorHarness: { mount: (phone: boolean, theme: 'light' | 'dark', state: State) => void } };

async function open(page: Page, phone: boolean, theme: 'light' | 'dark', state: State) {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/workflows/new`);
    await page.addScriptTag({ url: `${origin}/bundle.js` });
    await page.evaluate(({ phone, theme, state }) => (window as unknown as Harness).editorHarness.mount(phone, theme, state), { phone, theme, state });
    const root = page.getByTestId(BUILTIN_STATES.includes(state) ? 'workflow-builtin' : 'workflow-editor');
    try { await root.first().waitFor({ state: 'attached' }); } catch (error) {
        throw new Error(`${state} did not render: ${String(error)}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);
    }
    await page.waitForTimeout(400);
}

/** Boxes of the document's anchors, by test id prefix, for the fidelity report. */
async function measure(page: Page) {
    return page.evaluate(() => {
        const box = (element: Element | null) => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), width: Math.round(rect.width) };
        };
        const byId = (id: string) => box(document.querySelector(`[data-testid="${id}"]`));
        const all = (pattern: RegExp) => Object.fromEntries([...document.querySelectorAll('[data-testid]')]
            .filter(element => pattern.test(element.getAttribute('data-testid')!))
            .map(element => [element.getAttribute('data-testid'), box(element)]));
        return {
            viewport: { width: window.innerWidth },
            steps: byId('workflow-editor-steps-presentation') ?? byId('workflow-builtin-steps-presentation'),
            chips: byId('workflow-editor-chips') ?? byId('workflow-builtin-chips'),
            header: byId('workflow-editor-header') ?? byId('workflow-builtin-header'),
            anchors: all(/-(ordinal|ordinal-mark|label|card|prompt|returns|only-when|gap-.*|run-when)$/u),
        };
    });
}

describe('the editor page frame in a browser', () => {
    it('keeps the steps at the reading measure under a wide header, and never runs past a phone', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const wide = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
            await open(wide, false, 'light', 'habit');
            const frame = await wide.evaluate(() => {
                const rect = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
                return { steps: rect('workflow-editor-steps-presentation'), chips: rect('workflow-editor-chips'), card: rect('workflow-editor-action-notify-card') };
            });
            // Lab editor-E1: a ~640 px card column, left-aligned under the header, never the whole pane.
            expect(frame.steps.width).toBeLessThanOrEqual(704);
            expect(Math.abs(frame.steps.left - frame.chips.left)).toBeLessThanOrEqual(1);
            expect(frame.card.width).toBeLessThanOrEqual(660);
            await wide.close();
            for (const state of ['habit', 'keep-going', 'release'] as const) {
                const phone = await browser.newPage({ viewport: { width: 390, height: 2400 } });
                await open(phone, true, 'light', state);
                // Nothing (a chip, a card foot, a header action) runs past the phone's edge, except inside a
                // horizontal rail that scrolls by design (the composer's chip strip, the user's layout setting).
                const overflow = await phone.evaluate(() => [...document.querySelectorAll('[data-testid]')]
                    .filter(element => {
                        for (let node = element.parentElement; node; node = node.parentElement) {
                            const overflowX = getComputedStyle(node).overflowX;
                            if (overflowX === 'auto' || overflowX === 'scroll') return false;
                        }
                        return true;
                    })
                    .filter(element => element.getBoundingClientRect().right > window.innerWidth + 1 && element.getBoundingClientRect().width > 0)
                    .map(element => element.getAttribute('data-testid')));
                expect(overflow, state).toEqual([]);
                await phone.close();
            }
        } finally { await browser.close(); }
    }, 300_000);
});

describe('EDITOR-FIDELITY captures', () => {
    it.runIf(Boolean(process.env.EDITOR_FIDELITY_CAPTURE_DIR))('captures the owner\'s workflows at lab, wide and phone widths', async () => {
        const repositoryRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
        const directory = resolve(repositoryRoot, process.env.EDITOR_FIDELITY_CAPTURE_DIR!);
        await mkdir(directory, { recursive: true });
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const measurements: Record<string, unknown> = {};
        try {
            // DESIGN-13: EDITOR_FIDELITY_STATES / _WIDTHS / _HEIGHT narrow a capture round; defaults keep EDITOR-FIDELITY's set.
            const states = (process.env.EDITOR_FIDELITY_STATES?.split(',') ?? ['habit', 'keep-going']) as State[];
            const widths = process.env.EDITOR_FIDELITY_WIDTHS?.split(',').map(Number) ?? [390, 1440, 1920, 2560];
            const height = Number(process.env.EDITOR_FIDELITY_HEIGHT ?? 1800);
            for (const state of states) for (const theme of ['light', 'dark'] as const) {
                for (const width of widths) {
                    const phone = width === 390;
                    const page = await browser.newPage({ viewport: { width, height: phone ? Math.max(height, 2400) : height } });
                    await open(page, phone, theme, state);
                    const stem = `${state}-${width}-${theme}`;
                    await page.screenshot({ path: join(directory, `${stem}.png`) });
                    measurements[stem] = await measure(page);
                    if (!phone && width === 1440) {
                        // Workflow settings docked beside the document, as the lab draws it (editor-G1).
                        const prefix = BUILTIN_STATES.includes(state) ? 'workflow-builtin' : 'workflow-editor';
                        const toggle = page.getByTestId(`${prefix}-settings-toggle`);
                        await toggle.click();
                        await page.waitForTimeout(400);
                        await page.screenshot({ path: join(directory, `${stem}-settings.png`) });
                        measurements[`${stem}-settings`] = await measure(page);
                        // The workflow's inputs inside the settings pane (DESIGN-13 inputs row).
                        const inputs = page.getByTestId(`${prefix}-inputs`);
                        if (await inputs.count()) {
                            await inputs.first().scrollIntoViewIfNeeded();
                            await page.waitForTimeout(300);
                            await page.screenshot({ path: join(directory, `${stem}-settings-inputs.png`) });
                        }
                        await toggle.click();
                        await page.waitForTimeout(300);
                        // The Flow pane docked beside the steps (editor-L1).
                        const flow = page.getByTestId(`${prefix}-flow-toggle`);
                        if (await flow.count()) {
                            await flow.click();
                            await page.waitForTimeout(500);
                            await page.screenshot({ path: join(directory, `${stem}-flow.png`) });
                            await flow.click();
                            await page.waitForTimeout(300);
                        }
                        if (state === 'habit') {
                            // Step options of the Notify me step, anchored beside it (editor-L1).
                            await page.getByTestId('workflow-editor-action-notify-options').click();
                            await page.waitForTimeout(500);
                            await page.screenshot({ path: join(directory, `${stem}-step-options.png`) });
                            await page.keyboard.press('Escape');
                            await page.waitForTimeout(300);
                            // The editor menus: the page's ⋯ and a step's ⋯ (ADJ-UI-2 / editor menus).
                            await page.getByTestId('workflow-editor-menu').click();
                            await page.waitForTimeout(400);
                            await page.screenshot({ path: join(directory, `${stem}-page-menu.png`) });
                            await page.keyboard.press('Escape');
                            await page.waitForTimeout(300);
                            await page.getByTestId('workflow-editor-step-quiet-check-actions').click();
                            await page.waitForTimeout(400);
                            await page.screenshot({ path: join(directory, `${stem}-step-menu.png`) });
                            await page.keyboard.press('Escape');
                            await page.waitForTimeout(300);
                        }
                        if (state === 'plan') {
                            // The run launcher, anchored under Run now, with focus in its first field (FIX-UI-2 / ADJ-UI-2).
                            await page.getByTestId('workflow-builtin-run-now').click();
                            await page.waitForTimeout(600);
                            await page.screenshot({ path: join(directory, `${stem}-run-launcher.png`) });
                            measurements[`${stem}-run-launcher-focus`] = await page.evaluate(() => {
                                const active = document.activeElement;
                                return active === null ? null : { tag: active.tagName, testID: active.getAttribute('data-testid'), label: active.getAttribute('aria-label') };
                            });
                        }
                    }
                    await page.close();
                }
            }
            await writeFile(join(directory, 'measurements.json'), JSON.stringify(measurements, null, 2));
            expect(Object.keys(measurements).length).toBeGreaterThan(0);
        } finally { await browser.close(); }
    }, 900_000);
});
