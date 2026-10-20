import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { Button } from '../../components/Button.js';
import {
  readHappierPageOperation,
  splitHappierPagePrimaryOperation,
} from './pageOperations.js';

describe('splitHappierPagePrimaryOperation', () => {
  it('takes the one filled action out of a header row and leaves the quiet ones to fold', () => {
    // An editor's commit pair: on a phone, "Review changes" stays in the header and Cancel folds.
    const actions = (
      <React.Fragment>
        <Button title="Cancel" variant="plain" onPress={() => {}} />
        <Button title="Review changes" variant="primary" onPress={() => {}} />
      </React.Fragment>
    );
    const { primary, rest } = splitHappierPagePrimaryOperation(actions);
    expect(primary?.title).toBe('Review changes');
    const remaining = React.Children.toArray(
      (
        React.Children.toArray(rest)[0] as React.ReactElement<{
          children: React.ReactNode;
        }>
      ).props.children,
    ) as React.ReactElement[];
    expect(
      remaining.map((node) => readHappierPageOperation(node)?.title),
    ).toEqual(['Cancel']);
  });

  it('leaves a row without a filled action unchanged', () => {
    const { primary } = splitHappierPagePrimaryOperation(
      <Button title="Refresh" variant="secondary" onPress={() => {}} />,
    );
    expect(primary).toBeNull();
  });
});
