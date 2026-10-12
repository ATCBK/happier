import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeFile, applyEdits, repoRoot } from './codemod.mjs';

test('Inter numeric weights select a real face, including weight-only and existing-role styles, idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scale-roles-u2-'));
  const path = join(directory, 'Controls.tsx');
  try {
    await writeFile(path, `import { Typography } from '@/constants/Typography';
const styles = {
  body: { fontSize: 13, ...Typography.default(), fontWeight: '600' },
  rawBody: { fontSize: 13, fontFamily: 'Inter-Regular', fontWeight: '600' },
  italicBody: { fontSize: 13, ...Typography.default('italic'), fontWeight: '600' },
  reset: { ...Typography.default('semiBold'), fontWeight: '600' },
  role: { ...Typography.variant('micro'), fontWeight: '500' },
  raw: { fontFamily: 'Inter-Regular', fontWeight: '550' },
  mono: { fontFamily: 'IBMPlexMono-Regular', fontWeight: '600' },
  ambiguous: { fontSize: 18, ...Typography.default(), fontWeight: '600' },
  multiline: {
    fontSize: 13,
    ...Typography.default(),
    fontWeight: '600',
  },
};\n`);
    const first = await analyzeFile(path);
    const transformed = applyEdits(first.text, first.edits);
    assert.match(transformed, /Typography\.variant\('body', 'semiBold'\)/);
    assert.match(transformed, /rawBody: \{ \.\.\.Typography\.variant\('body', 'semiBold'\),\s*\}/);
    assert.match(transformed, /italicBody: \{ fontSize: 13, \.\.\.Typography\.default\('italic'\), fontWeight: '600' \}/);
    assert.match(transformed, /reset: \{ \.\.\.Typography\.default\('semiBold'\),\s*\}/);
    assert.match(transformed, /Typography\.variant\('micro', 'medium'\)/);
    assert.match(transformed, /raw: \{ \.\.\.Typography\.default\('medium'\),\s*\}/);
    assert.match(transformed, /mono: \{ fontFamily: 'IBMPlexMono-Regular', fontWeight: '600' \}/);
    assert.match(transformed, /ambiguous: \{ fontSize: 18, \.\.\.Typography\.default\(\), fontWeight: '600' \}/);
    assert.doesNotMatch(transformed, /^[ \t]+$/m);
    await writeFile(path, transformed);
    assert.equal((await analyzeFile(path)).edits.length, 0);
    assert.equal(await readFile(path, 'utf8'), transformed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plugin spacing uses only the unchanged public snapshot projections and flags unavailable steps', async () => {
  const directory = await mkdtemp(join(repoRoot, 'packages/plugin-ui/src/presentation/.codemod-test-'));
  const path = join(directory, 'Controls.tsx');
  try {
    await writeFile(path, `function style(theme) {
return { padding: 20, gap: 24, margin: 5, paddingTop: theme.spacing.small };
}
function unhosted() { const theme = useOptionalHappierUiTheme(); return { gap: 4 }; }\n`);
    const first = await analyzeFile(path);
    const transformed = applyEdits(first.text, first.edits);
    assert.match(transformed, /padding: theme\.spacing\.xlarge/);
    assert.match(transformed, /margin: theme\.spacing\.xsmall/);
    assert.match(transformed, /gap: 24/);
    assert.match(transformed, /return \{ gap: 4 \}/);
    assert.ok(!transformed.includes('theme.space.'));
    assert.equal(first.sites.filter(site => site.status === 'flagged').length, 2);
    await writeFile(path, transformed);
    const second = await analyzeFile(path);
    assert.equal(second.edits.length, 0);
    assert.equal(second.sites.filter(site => site.status === 'flagged').length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
