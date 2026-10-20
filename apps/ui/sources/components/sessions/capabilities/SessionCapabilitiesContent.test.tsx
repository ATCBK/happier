import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { SessionSkillPlanV1Schema } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';

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

type Entry = Readonly<{
  kind: 'skill' | 'mcp_server';
  id: string;
  ruleOn: boolean;
  override: 'added' | 'removed' | null;
}>;
const names = {
  machineName: () => 'nl2',
  projectName: () => 'happier',
  agentName: () => 'Codex',
  folderLabel: () => '~/happier',
};

function view(entries: readonly Entry[]) {
  const item = (entry: Entry) => ({
    kind: entry.kind,
    id: entry.id,
    name: entry.id,
    selectable: true,
    selected:
      entry.override === 'added'
        ? true
        : entry.override === 'removed'
          ? false
          : entry.ruleOn,
    reason: entry.ruleOn ? ('rule_on' as const) : ('rule_off' as const),
    sessionOverride: entry.override,
    decidedBy: {
      ruleId: entry.id,
      target: 'allMachines' as const,
      agentQualified: false,
    },
  });
  const parsed = SessionCapabilitiesGetOutputV1Schema.parse({
    ok: true,
    mcp: {
      items: entries
        .filter((entry) => entry.kind === 'mcp_server')
        .map((entry) => ({ ...item(entry), source: 'catalog' })),
    },
    skills: {
      items: entries.filter((entry) => entry.kind === 'skill').map(item),
      plan: SessionSkillPlanV1Schema.parse({
        plan: 'session_dir',
        items: [],
        nativeDisables: [],
        diagnostics: [],
      }),
    },
    pendingApply: { mcp: false, skills: false },
    applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } },
  });
  if (!parsed.ok) throw new Error('invalid fixture');
  return parsed;
}

async function render(
  entries: readonly Entry[],
  state: 'ready' | 'error' | 'machine_unreachable' | 'resolving' = 'ready',
  options: Readonly<{
    preview?: boolean;
    knownRows?: Readonly<{ skills: number; mcp: number }>;
    undo?: Parameters<
      typeof import('./SessionCapabilitiesContent').SessionCapabilitiesContent
    >[0]['undo'];
  }> = {},
) {
  const { buildSessionCapabilitiesModel } =
    await import('./sessionCapabilitiesModel');
  const { SessionCapabilitiesContent } =
    await import('./SessionCapabilitiesContent');
  const model = buildSessionCapabilitiesModel({
    view: options.preview === false ? null : view(entries),
    state,
    readOnly: false,
    names,
    rules: (_kind, id) => [
      {
        id,
        target: { t: 'allMachines' },
        enabled: entries.find((entry) => entry.id === id)?.ruleOn ?? false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    mcpStatus: () => [],
    skillStatus: () => [],
    cost: () => ({ tokensWhenUsed: 1200 }),
  });
  const changes: unknown[] = [];
  const onRetry = vi.fn();
  const screen = await renderScreen(
    <SessionCapabilitiesContent
      model={model}
      onChange={async (change) => {
        changes.push(change);
      }}
      onRetry={onRetry}
      undo={options.undo}
      knownRows={options.knownRows}
      machineName="nl2"
      testID="caps"
    />,
  );
  return { screen, changes, onRetry };
}

async function press(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  testID: string,
) {
  const { act } = await import('react');
  const node = screen.findAll(
    (candidate) =>
      candidate.props?.testID === testID &&
      typeof candidate.props?.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no pressable ${testID}`);
  await act(async () => {
    await node.props.onPress({});
  });
}

describe('SessionCapabilitiesContent', () => {
  it('turns an inherited row off, returns an added row to its rules, and turns a removed row back on', async () => {
    const { screen, changes } = await render([
      { kind: 'skill', id: 'code-review', ruleOn: true, override: null },
      { kind: 'skill', id: 'sql-migrations', ruleOn: false, override: 'added' },
      { kind: 'mcp_server', id: 'linear', ruleOn: true, override: 'removed' },
    ]);
    await press(screen, 'caps:row:skill:code-review:remove');
    await press(screen, 'caps:row:skill:sql-migrations:remove');
    await press(screen, 'caps:row:mcp_server:linear:turn-on');
    expect(changes).toEqual([
      { kind: 'skill', id: 'code-review', state: 'off' },
      { kind: 'skill', id: 'sql-migrations', state: 'inherit' },
      { kind: 'mcp_server', id: 'linear', state: 'inherit' },
    ]);
  });

  it('adds an item that exists but is off here from the add field', async () => {
    const { screen, changes } = await render([
      { kind: 'skill', id: 'code-review', ruleOn: true, override: null },
      { kind: 'mcp_server', id: 'postgres', ruleOn: false, override: null },
    ]);
    expect(
      screen.findAll(
        (node) => node.props?.testID === 'caps:row:mcp_server:postgres',
      ),
    ).toHaveLength(0);
    await press(screen, 'caps:add');
    await press(screen, 'caps:add:pick:mcp_server:postgres');
    expect(changes).toEqual([
      { kind: 'mcp_server', id: 'postgres', state: 'on' },
    ]);
  });

  it('offers Undo in place for the last change and hands the press to its owner', async () => {
    const onUndo = vi.fn();
    const entries: readonly Entry[] = [
      { kind: 'skill', id: 'code-review', ruleOn: true, override: null },
    ];
    const without = await render(entries);
    expect(
      without.screen.findAll((node) => node.props?.testID === 'caps:undo'),
    ).toHaveLength(0);
    const { screen } = await render(entries, 'ready', {
      undo: { title: 'pdf', change: 'removed', onUndo },
    });
    expect(
      screen.findAll((node) => node.props?.testID === 'caps:undo').length,
    ).toBeGreaterThan(0);
    const { t } = await import('@/text');
    const { act } = await import('react');
    const undo = screen.findAll(
      (node) =>
        node.props?.accessibilityLabel === t('capabilities.session.ask.undo') &&
        typeof node.props?.onPress === 'function',
    )[0];
    if (!undo) throw new Error('no Undo control in the line');
    await act(async () => {
      await undo.props.onPress({});
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('says a failed preview once with its retry, and keeps an empty group with its own line', async () => {
    const failed = await render(
      [{ kind: 'skill', id: 'code-review', ruleOn: true, override: null }],
      'error',
    );
    expect(
      failed.screen.findAll((node) => node.props?.testID === 'caps:error')
        .length,
    ).toBeGreaterThan(0);
    const empty = await render([
      { kind: 'skill', id: 'code-review', ruleOn: true, override: null },
    ]);
    expect(
      empty.screen.findAll((node) => node.props?.testID === 'caps:empty:mcp')
        .length,
    ).toBeGreaterThan(0);
    expect(
      empty.screen.findAll(
        (node) => node.props?.testID === 'caps:empty:skills',
      ),
    ).toHaveLength(0);
  });

  it('holds the groups open while the first preview loads: both headings, placeholder rows, a silent footer cost, and no empty claim', async () => {
    const loading = await render([], 'resolving', { preview: false });
    const ids = new Set(
      loading.screen
        .findAll((node) => typeof node.props?.testID === 'string')
        .map((node) => node.props.testID as string),
    );
    expect(ids.has('caps:group:skills')).toBe(true);
    expect(ids.has('caps:group:mcp')).toBe(true);
    expect(ids.has('caps:resolving')).toBe(true);
    expect([...ids].filter((id) => id.startsWith('caps:empty:'))).toEqual([]);
    const { t } = await import('@/text');
    expect(
      loading.screen.findAll((node) => node.props?.children === t('capabilities.session.costUnknown')),
    ).toHaveLength(0);
  });

  it('reserves the box the loaded groups will fill: what each held when last seen, else a full preview', async () => {
    const placeholders = (screen: Awaited<ReturnType<typeof render>>['screen'], testID: string) =>
      screen.findAll((node) => node.props?.testID === `${testID}:skeleton-row`).length;
    const unknown = await render([], 'resolving', { preview: false });
    const known = await render([], 'resolving', { preview: false, knownRows: { skills: 3, mcp: 9 } });
    const fullPreview = placeholders(unknown.screen, 'caps:resolving');
    // Unknown: a full preview in both groups. Known: 3 rows for the skills group; the MCP group (9) reserves a full
    // preview and the "n more" line below it.
    expect(placeholders(unknown.screen, 'caps:resolving:mcp')).toBe(fullPreview);
    expect(placeholders(known.screen, 'caps:resolving')).toBeLessThan(fullPreview);
    expect(placeholders(known.screen, 'caps:resolving:mcp')).toBe(fullPreview);
    expect(known.screen.findAll((node) => node.props?.testID === 'caps:resolving-more:mcp').length).toBeGreaterThan(0);
    expect(known.screen.findAll((node) => node.props?.testID === 'caps:resolving-more:skills')).toHaveLength(0);
  });

  it('says an offline machine once and never claims empty groups it could not check', async () => {
    const offline = await render([], 'machine_unreachable', { preview: false });
    const ids = new Set(
      offline.screen
        .findAll((node) => typeof node.props?.testID === 'string')
        .map((node) => node.props.testID as string),
    );
    expect(ids.has('caps:offline')).toBe(true);
    expect([...ids].filter((id) => id.startsWith('caps:group:'))).toEqual([]);
    expect([...ids].filter((id) => id.startsWith('caps:empty:'))).toEqual([]);
  });
});
