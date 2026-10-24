import { act, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import {
  HappierInputField,
  type HappierInputFieldDescriptor,
} from './InputField.js';
import { HappierInputPickerProvider, type HappierInputPickerPort } from './inputPicker.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../../presentationHost/context.js';

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
  it('states a settled empty options read and withdraws that state while loading or when choices arrive', async () => {
    const props = { field: { path: 'session', title: 'Session', widget: 'select' as const }, value: undefined,
      options: [], onChange: () => {}, frame: 'none' as const, theme, testID: 'session' };
    const view = mountThroughReactNativeWeb(<HappierInputField {...props} optionsStatus="ready" />);
    try {
      expect(view.container.querySelector('[aria-live="polite"]')?.textContent?.trim()).toBeTruthy();
      await view.render(<HappierInputField {...props} optionsStatus="loading" />);
      expect(view.container.querySelector('[aria-live="polite"]')).toBeNull();
      await view.render(<HappierInputField {...props} optionsStatus="ready" options={[{ value: 'session', label: 'Project session' }]} />);
      expect(view.container.querySelector('[aria-live="polite"]')).toBeNull();
    } finally { view.unmount(); }
  });
  it('does not offer a picker whose choices failed to load: Browse waits for Retry', async () => {
    const port: HappierInputPickerPort = {
      describe: () => ({ label: 'Browse…' }),
      pick: async () => ({ status: 'cancelled' }),
    };
    const field = { path: 'participant', title: 'Participant', widget: 'select' as const,
      inputType: { pluginId: 'com.acme.inputs', localId: 'participant' } };
    const render = (status: 'ready' | 'failed') => <HappierInputPickerProvider port={port}>
      <HappierInputField field={field} value={undefined} options={[]} optionsStatus={status}
        optionsNotice={<></>} onChange={() => {}} frame="none" theme={theme} testID="participant" />
    </HappierInputPickerProvider>;
    const trigger = (view: ReturnType<typeof mountThroughReactNativeWeb>) =>
      view.container.querySelector('[data-testid="participant-picker"]');
    const view = mountThroughReactNativeWeb(render('ready'));
    try {
      expect(trigger(view)?.textContent).toContain('Browse…');
      expect(trigger(view)?.getAttribute('aria-disabled')).not.toBe('true');
      await view.render(render('failed'));
      expect(trigger(view)?.getAttribute('aria-disabled')).toBe('true');
    } finally { view.unmount(); }
  });
  it('reads a declared "all" answer without an empty-options notice when nothing is there to narrow by', () => {
    const view = mountThroughReactNativeWeb(
      <HappierInputField
        field={{ path: 'agents', title: 'Agents', widget: 'multiselect', placeholder: 'All agents', required: false }}
        value={[]}
        selection={[]}
        options={[]}
        optionsStatus="ready"
        onChange={() => {}}
        frame="none"
        theme={theme}
        testID="agents"
      />,
    );
    try {
      expect(view.container.textContent).toContain('All agents');
      expect(view.container.querySelector('[aria-live="polite"]')).toBeNull();
      // An empty set has nothing to open: the field reads its answer and does not offer a blank list.
      expect(view.container.querySelector('[data-testid="agents.trigger"]')?.getAttribute('aria-disabled')).toBe('true');
    } finally { view.unmount(); }
  });
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

  it('hangs a field\'s floating choices from the drawn box, not from the wider press row around it', async () => {
    const anchors: unknown[] = [];
    const host: PluginUiPresentationHost = {
      renderMarkdown: () => null, renderCodeBlock: () => null, renderIcon: () => null,
      // The host's popover is the platform boundary; record what the field anchors it to.
      renderPopover: (input) => { anchors.push(input.anchorRef.current); return null; },
    };
    const five = ['a', 'b', 'c', 'd', 'e'].map((value) => ({ value, label: value.toUpperCase() }));
    const view = mountThroughReactNativeWeb(<PluginUiPresentationHostProviderInternal host={host}>
      <HappierInputField field={metric} value={undefined} options={five} onChange={() => {}} frame="none" theme={theme} testID="metric" />
    </PluginUiPresentationHostProviderInternal>);
    try {
      const trigger = view.container.querySelector<HTMLElement>('[data-testid="metric.trigger"]')!;
      await act(async () => { trigger.click(); });
      const anchor = anchors.at(-1) as HTMLElement | undefined;
      expect(anchor).toBeInstanceOf(HTMLElement);
      // The box sits inside the press target; the menu matches its width, so it is never the row itself.
      expect(anchor).not.toBe(trigger);
      expect(trigger.contains(anchor!)).toBe(true);
      expect(anchor!.textContent).toContain(trigger.textContent?.trim().slice(0, 3) ?? '');
    } finally { view.unmount(); }
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
