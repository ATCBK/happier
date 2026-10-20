import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as classic from 'zod';
import * as mini from 'zod/mini';

import { readDiscriminatedMembers, renderRuntimeEventReferenceMarkdown } from './generateRuntimeEventReference.mjs';

test('places every current runtime event in the generated reference', async () => {
  const { AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 } = await import('../../../packages/protocol/dist/runtime/agentSessionV1.js');
  const markdown = await renderRuntimeEventReferenceMarkdown();
  for (const kind of AGENT_SESSION_RUNTIME_EVENT_KINDS_V1.filter(kind => kind !== 'context-compaction')) {
    assert.ok(markdown.includes(`\`${kind}\``), `missing runtime event ${kind}`);
  }
});

for (const [name, z] of [['Classic', classic], ['Mini', mini]]) {
  test(`reads the literal of each real Zod ${name} union member`, () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('turn-start') }),
      z.object({ kind: z.literal('turn-complete') }),
    ]);
    assert.deepEqual(readDiscriminatedMembers(schema), ['turn-start', 'turn-complete']);
  });

  test(`refuses a Zod ${name} member whose discriminator is not a single literal`, () => {
    const broken = z.discriminatedUnion('kind', [z.object({ kind: z.string() })]);
    assert.throws(() => readDiscriminatedMembers(broken), /could not read the "kind" literal/);
  });
}

test('refuses to publish when the schema gains a kind no family claims', async () => {
  // The failure this prevents is silent: an unplaced kind simply would not
  // appear, and the page would read as complete while missing a whole event.
  const schemaPath = new URL('./__fixture-runtime-schema.mjs', import.meta.url).pathname;
  await assert.rejects(
    () => renderRuntimeEventReferenceMarkdown({ schemaPath }),
    /not assigned to a family: brand-new-kind/,
  );
});
