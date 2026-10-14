import { describe, expect, it } from 'vitest';

import {
  PromptBundleArtifactHeaderV1Schema,
  PromptBundleCreateActionInputV1Schema,
  PromptBundleBodyV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId,
  validateStoredPromptBundleBodyV1AgainstSchemaId,
  readSkillBundleContentV1,
  type PromptBundleBodyV1,
} from './promptBundleSchemas.js';
import retained from '../../../fixtures/0.2-retained-skill-path.json';
import retainedFrontmatter from '../../../fixtures/0.2-retained-skill-frontmatter.json';

describe('validatePromptBundleBodyV1AgainstSchemaId', () => {
  it('refuses generic bundle authoring while retaining predecessor stored headers', () => {
    const input = { title: 'Retained bundle', bundleSchemaId: 'bundle.generic_v1', entries: [] };
    expect(PromptBundleCreateActionInputV1Schema.safeParse(input).success).toBe(false);
    expect(PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2',
      title: input.title, bundleSchemaId: input.bundleSchemaId }).bundleSchemaId).toBe('bundle.generic_v1');
  });
  it.each(retainedFrontmatter.cases)('reads real predecessor writer output YAML-first, retaining non-YAML frontmatter: $id', vector => {
    const content = readSkillBundleContentV1({ header: vector.header, body: JSON.stringify(vector.body) });
    expect(content?.frontmatter).toMatchObject({ name: vector.expectedName, description: vector.expectedDescription });
    expect(content?.skillMd).toBe(vector.input.skillMarkdown);
  });
  it('keeps semantic validation closed without a fallback for valid YAML, and refuses missing names under both readers', () => {
    const vector = retainedFrontmatter.cases[0]!;
    for (const frontmatter of ['name: [sample]', 'name: sample\nuser-invocable: "false"', 'description: [unclosed']) {
      const body = { ...vector.body, entries: [{ ...vector.body.entries[0]!,
        contentBase64: Buffer.from(`---\n${frontmatter}\n---\nInstructions.`, 'utf8').toString('base64') }] };
      expect(readSkillBundleContentV1({ header: vector.header, body: JSON.stringify(body) })).toBeNull();
    }
  });
  it('keeps predecessor relative paths readable without weakening current writes or stored containment', () => {
    const body = PromptBundleBodyV1Schema.parse(retained.body);
    expect(validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body }))
      .toMatchObject({ ok: false, errorCode: 'invalid_path' });
    expect(readSkillBundleContentV1({ header: retained.header, body: JSON.stringify(body) })?.frontmatter.name).toBe('retained');
    for (const path of ['../escape', '/absolute', 'refs/../../escape', 'refs\\escape', 'refs//escape', 'refs/\u0000escape']) {
      expect(validateStoredPromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1',
        body: { ...body, entries: [...body.entries, { path, contentBase64: 'eA==', contentKind: 'utf8' }] } }))
        .toMatchObject({ ok: false, errorCode: 'invalid_path' });
    }
    expect(validateStoredPromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1',
      body: { ...body, entries: [...body.entries, body.entries[1]!] } })).toMatchObject({ ok: false, errorCode: 'duplicate_path' });
  });
  it('preserves zero-byte supporting files from real uploads and registry trees', () => {
    const body: PromptBundleBodyV1 = { v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentBase64: 'eA==', contentKind: 'utf8' },
      { path: 'scripts/__init__.py', contentBase64: '', contentKind: 'utf8' },
    ] };
    expect(validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body })).toEqual({ ok: true });
  });
  it.each(['CON.md', 'a:b', 'file.', 'file ', 'aux/file.md', 'a?.md'])('rejects Windows-invalid name %s before importing', path => {
    const body: PromptBundleBodyV1 = { v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentBase64: 'eA==', contentKind: 'utf8' },
      { path, contentBase64: 'eA==', contentKind: 'utf8' },
    ] };
    expect(validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body })).toMatchObject({ ok: false, errorCode: 'invalid_path', path });
  });
  it('preserves additive fields in bundle bodies and entries', () => {
    const parsed = PromptBundleBodyV1Schema.parse({
      v: 1,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Skill', 'utf8').toString('base64'),
          contentKind: 'utf8',
          futureEntryField: true,
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
      futureBundleField: {
        kind: 'prompt_bundle.v2',
      },
    });

    expect((parsed as any).futureBundleField).toEqual({
      kind: 'prompt_bundle.v2',
    });
    expect((parsed.entries[0] as any)?.futureEntryField).toBe(true);
  });

  it('accepts a minimal skill bundle with SKILL.md', () => {
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Skill', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(true);
  });

  it('rejects skill bundles missing SKILL.md', () => {
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: [
        {
          path: 'README.md',
          contentBase64: Buffer.from('x', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('missing_required_entry');
  });

  it('rejects traversal paths', () => {
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: [
        {
          path: '../SKILL.md',
          contentBase64: Buffer.from('x', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('invalid_path');
  });

  it('accepts valid supporting files beyond the former arbitrary 128-entry ceiling', () => {
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: Array.from({ length: 129 }, (_, index) => ({
        path: index === 0 ? 'SKILL.md' : `docs/file-${index}.md`,
        contentBase64: Buffer.from('x', 'utf8').toString('base64'),
        contentKind: 'utf8' as const,
      })),
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(true);
  });

  it('leaves real document quotas and transport budgets with their owners, accepting the measured 5.55MB registry skill size', () => {
    // anthropics/skills tree dbd4588f9e1033efb41dad4bef2f7947c8993d44: canvas-design has 5,554,003 decoded bytes.
    const oversizedSkillMarkdown = '# Skill\n' + 'a'.repeat(5_554_003);
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from(oversizedSkillMarkdown, 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(true);
  });

  it('reports invalid_request for malformed bundle bodies', () => {
    const res = validatePromptBundleBodyV1AgainstSchemaId({
      bundleSchemaId: 'skills.skill_md_v1',
      body: {
        v: 1,
        entries: [],
      } as unknown as PromptBundleBodyV1,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('invalid_request');
  });
});
