import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import {
  AccountUsernameField,
  type AccountUsernameCheck,
} from './AccountUsernameField';

function Harness(
  props: Readonly<{
    initial: string;
    check: AccountUsernameCheck | null;
    currentUsername?: string | null;
  }>,
) {
  const [value, setValue] = React.useState(props.initial);
  return (
    <AccountUsernameField
      testID="username"
      value={value}
      onChangeText={setValue}
      currentUsername={props.currentUsername ?? null}
      check={props.check}
    />
  );
}

const taken: AccountUsernameCheck = {
  raw: 'leeroy',
  result: {
    username: 'leeroy',
    availability: 'unavailable',
    suggestions: ['leeroybrun', 'leeroy-b'],
  },
};

describe('AccountUsernameField', () => {
  it('shows the service answer for the exact draft and fills the same draft from a returned suggestion', async () => {
    const screen = await renderScreen(
      <Harness initial="leeroy" check={taken} />,
    );
    expect(screen.findByTestId('username-answer')).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      t('publicIdentity.handle.taken', { username: 'leeroy' }),
    );
    await screen.pressByTestIdAsync('username-suggestion-leeroybrun');
    expect(screen.findByTestId('username')!.props.value).toBe('leeroybrun');
    // The answer was for "leeroy"; the new draft has no answer yet, so nothing claims it is taken.
    expect(screen.findByTestId('username-answer')).toBeNull();
  });

  it('never reports a stale answer, and marks only an available answer for this draft', async () => {
    const stale = await renderScreen(
      <Harness initial="leeroy2" check={taken} />,
    );
    expect(stale.findByTestId('username-answer')).toBeNull();
    expect(stale.findByTestId('username-available')).toBeNull();
    const available = await renderScreen(
      <Harness
        initial="leeroybrun"
        check={{
          raw: 'leeroybrun',
          result: {
            username: 'leeroybrun',
            availability: 'available',
            suggestions: [],
          },
        }}
      />,
    );
    expect(available.findByTestId('username-available')).not.toBeNull();
    expect(available.findByTestId('username-answer')).toBeNull();
  });

  it('names a reserved name without offering suggestions the service did not return', async () => {
    const screen = await renderScreen(
      <Harness
        initial="admin"
        check={{
          raw: 'admin',
          result: {
            username: 'admin',
            availability: 'reserved',
            suggestions: [],
          },
        }}
      />,
    );
    expect(screen.getTextContent()).toContain(
      t('publicIdentity.handle.reserved', { username: 'admin' }),
    );
    expect(
      screen.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('username-suggestion-')),
    ).toHaveLength(0);
  });

  it('explains what a rename changes only when the draft differs from the current handle', async () => {
    const renaming = await renderScreen(
      <Harness initial="leeroy-b" check={null} currentUsername="leeroy" />,
    );
    expect(renaming.getTextContent()).toContain(
      t('publicIdentity.handle.renameConsequence', { username: 'leeroy' }),
    );
    const unchanged = await renderScreen(
      <Harness initial="leeroy" check={null} currentUsername="leeroy" />,
    );
    expect(unchanged.getTextContent()).not.toContain(
      t('publicIdentity.handle.renameConsequence', { username: 'leeroy' }),
    );
  });
});
