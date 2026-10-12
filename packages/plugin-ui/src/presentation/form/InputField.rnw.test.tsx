import { act, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import {
  HappierInputField,
  type HappierInputFieldDescriptor,
} from './InputField.js';

const theme = createSurfaceContext().theme;
const metric: HappierInputFieldDescriptor = {
  path: 'metric',
  title: 'Metric',
  widget: 'select',
};
const two = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
];
const segmentedIn = (element: ReactNode) =>
  mountThroughReactNativeWeb(element).container.querySelector(
    '[data-testid="metric.segmented"]',
  );

describe('one typed field decides how a fixed choice is drawn, for every form', () => {
  it('draws two to four short choices as one segmented control and pins the pressed value', () => {
    const onChange = vi.fn();
    const view = mountThroughReactNativeWeb(
      <HappierInputField
        field={metric}
        value="tokens"
        selection="tokens"
        options={two}
        onChange={onChange}
        frame="none"
        theme={theme}
        testID="metric"
      />,
    );
    const group = view.container.querySelector(
      '[data-testid="metric.segmented"]',
    )!;
    expect(group).not.toBeNull();
    const segments = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(segments.map((segment) => segment.textContent)).toEqual([
      'Tokens',
      'Cost',
    ]);
    expect(
      segments.map((segment) => segment.getAttribute('aria-checked')),
    ).toEqual(['true', 'false']);
    act(() => {
      segments[1]!.click();
    });
    expect(onChange).toHaveBeenLastCalledWith('cost');
  });

  it('keeps a list for choices that explain themselves, carry long labels, number five or more, or take several values', () => {
    const described = two.map((option) => ({
      ...option,
      description: `${option.label} per day`,
    }));
    const five = ['a', 'b', 'c', 'd', 'e'].map((value) => ({
      value,
      label: value.toUpperCase(),
    }));
    const long = [
      { value: 'auto', label: 'Best available cost' },
      { value: 'reported', label: 'Reported by agents' },
    ];
    expect(
      segmentedIn(
        <HappierInputField
          field={metric}
          value="auto"
          selection="auto"
          options={long}
          onChange={() => {}}
          frame="none"
          theme={theme}
          testID="metric"
        />,
      ),
    ).toBeNull();
    expect(
      segmentedIn(
        <HappierInputField
          field={metric}
          value="tokens"
          selection="tokens"
          options={described}
          onChange={() => {}}
          frame="none"
          theme={theme}
          testID="metric"
        />,
      ),
    ).toBeNull();
    expect(
      segmentedIn(
        <HappierInputField
          field={metric}
          value="a"
          selection="a"
          options={five}
          onChange={() => {}}
          frame="none"
          theme={theme}
          testID="metric"
        />,
      ),
    ).toBeNull();
    expect(
      segmentedIn(
        <HappierInputField
          field={{ ...metric, widget: 'multiselect' }}
          value={[]}
          selection={[]}
          options={two}
          onChange={() => {}}
          frame="none"
          theme={theme}
          testID="metric"
        />,
      ),
    ).toBeNull();
  });
});
