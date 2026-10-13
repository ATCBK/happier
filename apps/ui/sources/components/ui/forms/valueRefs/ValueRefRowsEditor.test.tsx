import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { installValueRefsCommonModuleMocks } from './valueRefsTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installValueRefsCommonModuleMocks();

afterEach(() => {
  standardCleanup();
});

async function mount(entries: Record<string, ValueRefV1>) {
  const onChangeEntries = vi.fn();
  const { ValueRefRowsEditor } = await import('./ValueRefRowsEditor');
  const screen = await renderScreen(
    <ValueRefRowsEditor
      kind="env"
      entries={entries}
      onChangeEntries={onChangeEntries}
      secrets={[]}
      addLabel="Add a variable"
      testIdPrefix="env"
    />,
  );
  return { screen, onChangeEntries };
}

function input(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  testID: string,
) {
  const node = screen
    .findAllByTestId(testID)
    .find((candidate) => typeof candidate.props.onChangeText === 'function');
  if (!node) throw new Error(`no field ${testID}`);
  return node;
}

async function type(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  testID: string,
  text: string,
) {
  await act(async () => {
    input(screen, testID).props.onChangeText(text);
  });
  await act(async () => {
    input(screen, testID).props.onBlur?.();
  });
}

describe('ValueRefRowsEditor', () => {
  it('saves a value in place when focus leaves it, keeping the other rows as they are', async () => {
    const kept: ValueRefV1 = { t: 'savedSecret', secretId: 'db-url' };
    const { screen, onChangeEntries } = await mount({
      PGSSLMODE: { t: 'literal', v: 'prefer' },
      DATABASE_URL: kept,
    });
    expect(onChangeEntries).not.toHaveBeenCalled();

    await type(screen, 'env.row.1.value', 'require');
    expect(onChangeEntries).toHaveBeenCalledTimes(1);
    expect(onChangeEntries).toHaveBeenLastCalledWith({
      DATABASE_URL: kept,
      PGSSLMODE: { t: 'literal', v: 'require' },
    });
  });

  it('renames in place and refuses a name the environment cannot carry, saying why', async () => {
    const { screen, onChangeEntries } = await mount({
      PGAPPNAME: { t: 'literal', v: '${USER}' },
    });

    await type(screen, 'env.row.0.name', '9bad name');
    expect(onChangeEntries).not.toHaveBeenCalled();
    expect(screen.findAllByTestId('env.row.0.error').length).toBeGreaterThan(0);

    await type(screen, 'env.row.0.name', 'pg_app');
    expect(onChangeEntries).toHaveBeenLastCalledWith({
      PG_APP: { t: 'literal', v: '${USER}' },
    });
  });

  it('adds a row only once it has a name and a value', async () => {
    const { screen, onChangeEntries } = await mount({});
    await act(async () => {
      screen.findByTestId('env.add').props.onPress();
    });

    // Leaving the new name for its value files nothing yet.
    await type(screen, 'env.row.new.name', 'API_KEY');
    expect(onChangeEntries).not.toHaveBeenCalled();

    await type(screen, 'env.row.new.value', 'sk-123');
    expect(onChangeEntries).toHaveBeenLastCalledWith({
      API_KEY: { t: 'literal', v: 'sk-123' },
    });
  });
});
