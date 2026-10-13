import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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
  vi.resetModules();
});

type Skill = Readonly<{ name: string; description: string }>;
const SKILLS: readonly Skill[] = [
  { name: 'docx', description: 'Create and edit Word documents.' },
  { name: 'pdf', description: 'Read, fill and merge PDF files.' },
];

async function renderBody(
  primary: (
    skill: Skill,
  ) => Promise<Readonly<{ itemId: string; then?: 'close' | 'stay' }>>,
) {
  const { CapabilityAddModalBody } = await import('./CapabilityAddModal');
  const { buildCapabilityCollectionAnatomy } =
    await import('@/components/capabilities/row/buildCapabilityCollectionAnatomy');
  const onClose = vi.fn();
  const onAdded = vi.fn();
  const config = {
    title: 'Add a skill',
    modes: [
      {
        key: 'browse',
        label: 'Browse',
        icon: 'magnifying-glass' as const,
        kind: 'catalog' as const,
      },
    ],
    catalog: {
      query: '',
      onQueryChange: () => {},
      searchPlaceholder: 'Search skills',
      items: SKILLS,
      itemKey: (skill: Skill) => skill.name,
      anatomy: buildCapabilityCollectionAnatomy<Skill>({
        title: (skill) => skill.name,
        description: (skill) => skill.description,
        facts: () => ({ presentation: 'row' as const }),
        accessibilityLabel: (skill) => skill.name,
        testID: (skill) => `row:${skill.name}`,
      }),
      loading: false,
      empty: null,
    },
    renderDetail: (skill: Skill) => (
      <React.Fragment>{skill.description}</React.Fragment>
    ),
    detailFooter: (skill: Skill) => ({
      primary: { label: 'Add to library', onPress: () => primary(skill) },
    }),
    onAdded,
    testID: 'add',
  };
  const screen = await renderScreen(
    <CapabilityAddModalBody config={config as never} onClose={onClose} />,
  );
  const nodes = (testID: string) =>
    screen.findAll((node) => node.props?.testID === testID);
  const pressable = (testID: string) =>
    screen.findAll(
      (node) =>
        node.props?.testID === testID &&
        typeof node.props?.onPress === 'function',
    )[0];
  /** Choose a row as its press does: through the Collection model's own open action. */
  const select = async (name: string) => {
    const collection = screen.findAll(
      (node) => node.props?.testID === 'add:collection' && typeof node.props?.model?.actions?.open === 'function',
    )[0];
    if (!collection) throw new Error('collection not rendered');
    await act(async () => {
      collection.props.model.actions.open(name);
    });
  };
  const pressPrimary = async () => {
    const button = pressable('add:primary');
    if (!button) throw new Error('primary is not pressable');
    await act(async () => {
      await button.props.onPress();
    });
  };
  return { screen, nodes, select, pressPrimary, onClose, onAdded };
}

describe('CapabilityAddModalBody', () => {
  it('opens the details for the selected row, adds, then closes onto the new item', async () => {
    const body = await renderBody(async (skill) => ({
      itemId: `skill-${skill.name}`,
    }));
    await body.select('docx');
    expect(body.nodes('add:detail:docx').length).toBeGreaterThan(0);
    await body.pressPrimary();
    expect(body.onClose).toHaveBeenCalledTimes(1);
    expect(body.onAdded).toHaveBeenCalledWith({ itemId: 'skill-docx' });
  });

  it('keeps the dialog open on the added item when the primary asks to stay', async () => {
    const body = await renderBody(async (skill) => ({
      itemId: `skill-${skill.name}`,
      then: 'stay',
    }));
    await body.select('pdf');
    await body.pressPrimary();
    expect(body.onClose).not.toHaveBeenCalled();
    expect(body.onAdded).not.toHaveBeenCalled();
    expect(body.nodes('add:detail:pdf').length).toBeGreaterThan(0);
  });

  it('shows a failed add on the footer line and keeps the details', async () => {
    const body = await renderBody(async () => {
      throw new Error('registry_unreachable');
    });
    await body.select('docx');
    await body.pressPrimary();
    expect(body.nodes('add:primary-error').length).toBeGreaterThan(0);
    expect(body.onClose).not.toHaveBeenCalled();
    expect(body.nodes('add:detail:docx').length).toBeGreaterThan(0);
  });

  it('lets Escape close the details before the dialog, whatever has focus', async () => {
    const { dispatchEscapeToLayerStack } = await import('@/keyboard/escape');
    const body = await renderBody(async (skill) => ({ itemId: skill.name }));
    await body.select('docx');
    expect(body.nodes('add:detail:docx').length).toBeGreaterThan(0);
    let handled = false;
    await act(async () => {
      handled = dispatchEscapeToLayerStack({
        key: 'Escape',
        target: null,
        preventDefault: () => {},
        stopPropagation: () => {},
      });
    });
    expect(handled).toBe(true);
    expect(body.nodes('add:detail:docx')).toHaveLength(0);
    expect(body.onClose).not.toHaveBeenCalled();
  });
});
