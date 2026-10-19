import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillReadResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import { SkillFilesSection } from './SkillFilesSection';

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

const read: SkillReadResultV1 = {
  skillId: 's',
  name: 'impl-fix3-reviewed',
  skillMd: '---\nname: impl-fix3-reviewed\n---\n',
  revision: 'r1',
  provenance: { kind: 'written' },
  modified: false,
  trust: 'text_only',
  cost: { descriptionTokens: 10, bodyTokens: 1400 },
  rules: [],
  files: [
    { path: 'SKILL.md', bytes: 120 },
    { path: 'checklist.md', bytes: 480 },
  ],
};

describe('SkillFilesSection', () => {
  it('keeps a file row\'s overflow actions outside the row\'s own pressable header', async () => {
    const screen = await renderScreen(
      <SkillFilesSection
        read={read}
        readOnly={false}
        update={async () => ({ ok: true as const, revision: 'r2' })}
        readFile={async () => ({ text: '' })}
        testID="files"
      />,
    );

    const header = screen.findHostByTestId('files:file:checklist.md');
    expect(header).not.toBeNull();
    // A pressable header that contains another pressable renders <button> inside <button> on web.
    const nestedPressables = header!.findAll(
      (node) => node !== header && typeof node.props?.onPress === 'function',
    );
    expect(nestedPressables).toHaveLength(0);
    // The overflow control is still rendered for the row.
    expect(
      screen.findAll(
        (node) =>
          typeof node.type === 'string' &&
          typeof node.props?.onPress === 'function' &&
          typeof node.props?.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.includes('checklist.md'),
      ).length,
    ).toBeGreaterThan(0);
  });
});
