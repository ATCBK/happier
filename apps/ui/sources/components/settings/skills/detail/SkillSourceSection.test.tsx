import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillReadResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { t } from '@/text';

import { SkillSourceSection } from './SkillSourceSection';
import { skillSource } from '../skillsCollectionModel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
});

function read(
  provenance: SkillReadResultV1['provenance'],
  upstream?: SkillReadResultV1['upstream'],
): SkillReadResultV1 {
  return {
    skillId: 's',
    name: 'code-review',
    skillMd: '---\nname: code-review\n---\n',
    revision: 'r1',
    provenance,
    ...(upstream ? { upstream } : {}),
    modified: false,
    trust: 'text_only',
    cost: { descriptionTokens: 10, bodyTokens: 1400 },
    rules: [],
    files: [{ path: 'SKILL.md', bytes: 120 }],
  };
}

const common = {
  machineName: (id: string) => id,
  checkNow: () => undefined,
  checking: false,
  checkedAt: null,
  checkFailed: false,
  onViewUpdate: () => undefined,
  update: async () => ({ ok: true as const, revision: 'r2' }),
  testID: 'src',
};

describe('SkillSourceSection', () => {
  it('names the supplying plugin and omits unknown source metadata without claiming personal ownership', async () => {
    const pluginId = 'com.acme.skills';
    const pluginRead = SkillReadResultV1Schema.parse({ ...read({
      kind: 'plugin', pluginId, occurrenceId: 'acme-runtime',
    }), revision: '1:1' });
    const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
      installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Acme Skills', enabled: true,
        source: { kind: 'path', locator: '/plugins/acme' } } },
    }));
    const source = skillSource(pluginRead, common.machineName, projection.installedPackagesById);
    if (source?.kind !== 'plugin') throw new Error('Canonical plugin source metadata must be available');
    const screen = await renderScreen(<SkillSourceSection {...common} read={pluginRead}
      pluginSource={source} updatePolicy="manual" />);
    expect(screen.findByTestId('src:source')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Acme Skills');
    expect(screen.getTextContent()).not.toContain(t('capabilities.skillDetail.source.descriptionOwn'));
    expect(screen.findByTestId('src:checkNow')).toBeNull();
    expect(screen.findByTestId('src:auto')).toBeNull();
    expect(screen.findByTestId('src:pin')).toBeNull();

    await screen.update(<SkillSourceSection {...common} read={pluginRead} updatePolicy="manual" />);
    expect(screen.findByTestId('src:source')).toBeNull();
    expect(screen.getTextContent()).not.toContain(pluginId);
    expect(screen.getTextContent()).not.toContain(t('capabilities.skillDetail.source.descriptionOwn'));
    await screen.update(<SkillSourceSection {...common} read={pluginRead}
      pluginSource={source} updatePolicy="manual" />);
    expect(screen.getTextContent()).toContain('Acme Skills');
  });

  it('a written skill says "Written by you" and offers no update controls', async () => {
    const screen = await renderScreen(
      <SkillSourceSection
        {...common}
        read={read({ kind: 'written' })}
        updatePolicy="manual"
      />,
    );
    expect(screen.getTextContent()).toContain('Written by you');
    expect(screen.findAllByTestId('src:checkNow')).toHaveLength(0);
    expect(screen.findAllByTestId('src:auto')).toHaveLength(0);
    expect(screen.findAllByTestId('src:pin')).toHaveLength(0);
  });

  it('a registry skill shows its update state with Check now, automatic updates and pinning', async () => {
    const screen = await renderScreen(
      <SkillSourceSection
        {...common}
        updatePolicy="manual"
        read={read(
          {
            kind: 'registry',
            registry: {
              sourceId: 'skills-sh',
              format: 'skills-sh',
              sourceUrl: 'https://github.com/anthropics/skills',
              itemId: 'code-review',
              importedAt: 1,
              ref: {
                kind: 'gitTree',
                repo: 'anthropics/skills',
                path: 'skills/code-review',
                commit: '4f2a1c9aaaa',
                treeSha: 't',
              },
            },
          } as SkillReadResultV1['provenance'],
          { state: 'current' },
        )}
      />,
    );
    expect(screen.getTextContent()).toContain('anthropics/skills');
    expect(screen.getTextContent()).toContain('Up to date');
    expect(screen.findAllByTestId('src:checkNow').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('src:auto').length).toBeGreaterThan(0);
  });
  it('notes the files an imported skill points at that its copy lacks, and says nothing for one written here', async () => {
    const withLink = {
      ...read({
        kind: 'upload',
        importedAt: 1,
      }),
      skillMd: '---\nname: code-review\n---\nFollow [the checklist](../../shared/checklist.md).',
    };
    const imported = await renderScreen(
      <SkillSourceSection {...common} read={withLink} updatePolicy="manual" />,
    );
    expect(imported.findByTestId('src:outsideReferences')).not.toBeNull();
    expect(imported.getTextContent()).toContain('../../shared/checklist.md');
    const written = await renderScreen(
      <SkillSourceSection
        {...common}
        read={{ ...withLink, provenance: { kind: 'written' } }}
        updatePolicy="manual"
      />,
    );
    expect(written.findByTestId('src:outsideReferences')).toBeNull();
  });
});
