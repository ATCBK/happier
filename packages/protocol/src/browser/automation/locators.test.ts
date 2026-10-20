import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseLocator, resolveBrowserLocatorElements } from './locators.js';

describe('browser locator grammar', () => {
  it('parses semantic locators and preserves CSS fallbacks', () => {
    expect(parseLocator(' role= Button[name="Sign in"] ')).toEqual({ strategy: 'role', role: 'button', name: 'Sign in' });
    expect(parseLocator("role=link[name='Go next']")).toEqual({ strategy: 'role', role: 'link', name: 'Go next' });
    expect(parseLocator('role=alert')).toEqual({ strategy: 'role', role: 'alert' });
    expect(parseLocator('text="Go next"')).toEqual({ strategy: 'text', text: 'Go next' });
    expect(parseLocator('data-testid=email-field')).toEqual({ strategy: 'testid', testId: 'email-field' });
    expect(parseLocator('testid=email-field')).toEqual({ strategy: 'testid', testId: 'email-field' });
    expect(parseLocator('css=.cta')).toEqual({ strategy: 'css', selector: 'css=.cta' });
    expect(parseLocator(' .cta ')).toEqual({ strategy: 'css', selector: '.cta' });
    expect(parseLocator('role=bad role')).toEqual({ strategy: 'role', role: 'bad role' });
  });
});

describe('browser locator resolution', () => {
  it('resolves structural elements and preserves their identity through serialized execution', () => {
    const button = {
      id: 'continue', tagName: 'BUTTON', textContent: 'Continue', children: [],
      getAttribute(name: string) { return name === 'data-testid' ? 'continue' : null; },
    };
    const page = { querySelectorAll(_selector: string) { return [button]; } };
    for (const input of ['role=button[name="Continue"]', 'text=Continue', 'testid=continue', '#continue']) {
      const locator = parseLocator(input);
      expect(resolveBrowserLocatorElements(locator, page)).toEqual([button]);
      const serialized = Function('locator', 'page', `return (${resolveBrowserLocatorElements.toString()})(locator, page);`);
      expect(serialized(locator, page)).toEqual([button]);
    }
  });

  it('compiles strict non-DOM structural callers and retains real DOM element subtypes', async () => {
    const protocolRoot = resolve(import.meta.dirname, '../../..');
    const repositoryRoot = resolve(protocolRoot, '../..');
    const scratch = await mkdtemp(join(protocolRoot, '.tmp.locator-types-'));
    const prelude = `
      import { resolveBrowserLocatorElements } from '../src/browser/automation/locators.js';
      type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
      type Expect<T extends true> = T;
    `;
    try {
      for (const [profile, lib, consumer] of [
        ['structural', ['ES2022'], `
          type Item = Readonly<{
            id: string; tagName: string; textContent: string | null;
            children: ArrayLike<Item>; getAttribute(name: string): string | null;
          }>;
          declare const page: { querySelectorAll(selector: string): ArrayLike<Item> };
          const items = resolveBrowserLocatorElements({ strategy: 'text', text: 'Continue' }, page);
          type InferredItems = Expect<Equal<typeof items, Item[]>>;
          const id: string = items[0].id;
        `],
        ['dom', ['ES2022', 'DOM'], `
          declare const page: Document;
          const elements = resolveBrowserLocatorElements({ strategy: 'css', selector: '*' }, page);
          type InferredElements = Expect<Equal<typeof elements, Element[]>>;
          const buttonPage = { querySelectorAll(selector: string) { return page.querySelectorAll<HTMLButtonElement>(selector); } };
          const buttons = resolveBrowserLocatorElements({ strategy: 'css', selector: 'button' }, buttonPage);
          type InferredButtons = Expect<Equal<typeof buttons, HTMLButtonElement[]>>;
          const disabled: boolean = buttons[0].disabled;
        `],
      ] as const) {
        await writeFile(join(scratch, `${profile}.ts`), prelude + consumer);
        const config = join(scratch, `${profile}.json`);
        await writeFile(config, JSON.stringify({
          compilerOptions: {
            target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
            lib, strict: true, skipLibCheck: false, types: [], noEmit: true,
          },
          files: [`./${profile}.ts`],
        }));
        const result = spawnSync(process.execPath, [
          join(repositoryRoot, 'scripts/workspaces/runTypeScriptCli.mjs'), '-p', config, '--pretty', 'false',
        ], { cwd: repositoryRoot, encoding: 'utf8' });
        expect(result.status, `${profile}: ${result.stdout}\n${result.stderr}`).toBe(0);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
