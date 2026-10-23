import { describe, expect, it, vi } from 'vitest';

vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>();
  return { default: { parse: actual.parse } };
});

import { inspectProjectDefinitionFacts } from './nativeDefinitionInspection';

describe('native definition inspection under the bundled yaml module shape', () => {
  it('reads Taskfile tasks when CommonJS exports are exposed through default', async () => {
    const result = await inspectProjectDefinitionFacts('/workspace', [{
      file: 'Taskfile.yml',
      content: 'tasks:\n  build:\n    cmds: [echo ok]\n',
      format: 'taskfile',
    }]);

    expect(result.entries).toContainEqual({
      source: { kind: 'native', tool: 'taskfile', file: 'Taskfile.yml', target: 'build' },
      usage: 'script',
    });
  });
});
