import { writeFile } from 'node:fs/promises';

/** Observe the real Node loader without redirecting or substituting modules. */
export async function writeModuleLoadObserver(observerPath: string, observationsPath: string): Promise<void> {
  await writeFile(observationsPath, '', 'utf8');
  await writeFile(observerPath, [
    'import { appendFileSync } from "node:fs";',
    'let output;',
    'export function initialize(data) { output = data.output; }',
    'export async function load(url, context, nextLoad) {',
    '  const result = await nextLoad(url, context);',
    '  appendFileSync(output, JSON.stringify(url) + "\\n");',
    '  return result;',
    '}',
  ].join('\n'), 'utf8');
}
