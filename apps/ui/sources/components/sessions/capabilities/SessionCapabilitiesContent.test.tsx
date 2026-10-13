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
) {
  const { buildSessionCapabilitiesModel } =
    await import('./sessionCapabilitiesModel');
  const { SessionCapabilitiesContent } =
    await import('./SessionCapabilitiesContent');
  const model = buildSessionCapabilitiesModel({
    view: view(entries),
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
});
