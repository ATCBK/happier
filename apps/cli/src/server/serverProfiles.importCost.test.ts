import { Session } from 'node:inspector';
import { expect, it } from 'vitest';

const ownerUrl = new URL('./serverProfiles.ts', import.meta.url).href;
const deferredObservationUrls = [
  new URL('../features/serverFeaturesClient.ts', import.meta.url).href,
  new URL('../features/serverFeaturesParse.ts', import.meta.url).href,
  new URL('../auth/terminalAuthEnrollmentClient.ts', import.meta.url).href,
];

// Cold source preparation runs during module collection, like normal static
// imports. The deciding contract is evaluated-module count, never wall time.
const scripts = await readProfileImportScripts();

async function readProfileImportScripts() {
  const session = new Session();
  const scripts: string[] = [];
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => scripts.push(params.url.split('?')[0]));
  try {
    await new Promise<void>((resolve, reject) => {
      session.post('Debugger.enable', (error) => error ? reject(error) : resolve());
    });
    scripts.length = 0;
    await import('./serverProfiles');
    return scripts;
  } finally {
    session.disconnect();
  }
}

it('loads server profile selection without Agent installers or feature observation dependencies', () => {
  expect(scripts).toContain(ownerUrl);
  expect(scripts.filter((url) => deferredObservationUrls.includes(url)
    || /\/packages\/cli-common\/(?:src|dist)\/agents\/(?:index|install)\.(?:ts|js)$/.test(url))).toEqual([]);
});
