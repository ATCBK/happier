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
  it('shows a refusal when picking a Saved Secret would duplicate a variable name', async () => {
    const { screen, onChangeEntries } = await mount({ API_KEY: { t: 'literal', v: '${API_KEY}' } });
    await act(async () => { screen.pressByTestId('env.add'); });
    await act(async () => { input(screen, 'env.row.new.name').props.onChangeText('API_KEY'); });
    await act(async () => {
      screen.findAllByTestId('env.row.new.type').find(node => typeof node.props.onSelect === 'function')!.props.onSelect('savedSecret');
    });
    const { Modal } = await import('@/modal');
    const picker = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    if (!picker || !('props' in picker)) throw new Error('Expected secret picker');
    const select = (picker.props as { onSelectId: (id: string) => void }).onSelectId;
    await act(async () => { select('happier:shared-secret:v1:secret-a'); });
    expect(onChangeEntries).not.toHaveBeenCalled();
    expect(screen.findAllByTestId('env.row.new.error').some(node => node.props.children === 'capabilities.valueRows.duplicateName')).toBe(true);
  });
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
      screen.pressByTestId('env.add');
    });

    // Leaving the new name for its value files nothing yet.
    await type(screen, 'env.row.new.name', 'API_KEY');
    expect(onChangeEntries).not.toHaveBeenCalled();

    await type(screen, 'env.row.new.value', 'sk-123');
    expect(onChangeEntries).toHaveBeenLastCalledWith({
      API_KEY: { t: 'literal', v: 'sk-123' },
    });
  });
  it('says what a declared input is under its one name, never repeating the name in a second line', async () => {
    const { ValueRefRowsEditor } = await import('./ValueRefRowsEditor');
    const screen = await renderScreen(
      <ValueRefRowsEditor
        kind="env"
        declaredNames
        entries={{ BRAVE_API_KEY: { t: 'literal', v: '' } }}
        descriptions={{ BRAVE_API_KEY: 'Your API key from the Brave dashboard' }}
        onChangeEntries={vi.fn()}
        secrets={[]}
        testIdPrefix="env"
      />,
    );
    // The declared name carries zero-width break points after underscores.
    const text = screen.getTextContent().replaceAll('\u200b', '');
    expect(text).toContain('Your API key from the Brave dashboard');
    expect(text.split('BRAVE_API_KEY').length - 1).toBe(1);
  });
});
