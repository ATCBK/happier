import { act, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import * as publicUi from '../../index.public.js';
import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

function surface(children: ReactNode) {
  return (
    <HappierUiEnvironmentProvider
      environment={projectHappierUiEnvironment(createSurfaceContext())}
    >
      {children}
    </HappierUiEnvironmentProvider>
  );
}

it('lets authors toggle a trigger independently from opening it, including disabled writes', async () => {
  expect(publicUi.HappierTriggerRow).toBeTypeOf('function');
  const open = vi.fn();
  const toggle = vi.fn();
  const mounted = mountThroughReactNativeWeb(
    surface(
      <publicUi.HappierTriggerRow
        testID="trigger"
        title="Daily digest"
        qualifier="Every morning"
        enabled
        toggleLabel="Turn off Daily digest"
        onToggle={toggle}
        onPress={open}
      />,
    ),
  );
  try {
    const row = mounted.container.querySelector<HTMLElement>(
      '[data-testid="trigger"]',
    )!;
    const control = mounted.container.querySelector<HTMLElement>(
      '[data-testid="trigger-switch"]',
    )!;
    expect(row.contains(control)).toBe(false);
    expect(control.getAttribute('role')).toBe('switch');
    expect(control.getAttribute('aria-checked')).toBe('true');
    act(() => control.click());
    expect(toggle).toHaveBeenCalledWith(false);
    expect(open).not.toHaveBeenCalled();
    act(() => row.click());
    expect(open).toHaveBeenCalledOnce();
    await mounted.render(
      surface(
        <publicUi.HappierTriggerRow
          testID="trigger"
          title="Daily digest"
          enabled
          toggleDisabled
          toggleLabel="Turn off Daily digest"
          onToggle={toggle}
          onPress={open}
        />,
      ),
    );
    act(() =>
      mounted.container
        .querySelector<HTMLElement>('[data-testid="trigger-switch"]')!
        .click(),
    );
    expect(toggle).toHaveBeenCalledOnce();
  } finally {
    mounted.unmount();
  }
});

it('lets the host place provenance: a linked chip and a static one follow the same cross-axis alignment', async () => {
  // A transcript draws the chip above a right-aligned message; the link must not pin itself to the
  // start edge while its static form follows the host (DESIGN-SESSION, lab lane12-final b-habit Q).
  const alignment = (element: HTMLElement) =>
    getComputedStyle(element).alignSelf;
  const mounted = mountThroughReactNativeWeb(
    surface(
      <publicUi.HappierProvenanceChip
        label="From Daily digest · step 1"
        testID="linked"
        onPress={() => {}}
      />,
    ),
  );
  try {
    const linked = alignment(
      mounted.container.querySelector<HTMLElement>('[data-testid="linked"]')!,
    );
    await mounted.render(
      surface(
        <publicUi.HappierProvenanceChip
          label="From Daily digest · step 1"
          testID="static"
        />,
      ),
    );
    const plain = alignment(
      mounted.container.querySelector<HTMLElement>('[data-testid="static"]')!,
    );
    expect(linked).not.toBe('flex-start');
    expect(linked).toBe(plain);
  } finally {
    mounted.unmount();
  }
});

it('renders caller-qualified provenance as a named link or a non-interactive source', async () => {
  expect(publicUi.HappierProvenanceChip).toBeTypeOf('function');
  const open = vi.fn();
  const mounted = mountThroughReactNativeWeb(
    surface(
      <publicUi.HappierProvenanceChip
        label="From Daily digest · step 3"
        accessibilityLabel="Open producing step"
        testID="source"
        onPress={open}
      />,
    ),
  );
  try {
    const chip = mounted.container.querySelector<HTMLElement>(
      '[data-testid="source"]',
    )!;
    expect(chip.getAttribute('role')).toBe('link');
    expect(chip.getAttribute('aria-label')).toBe('Open producing step');
    act(() => chip.click());
    expect(open).toHaveBeenCalledOnce();
    await mounted.render(
      surface(
        <publicUi.HappierProvenanceChip
          label="From a workflow"
          testID="source"
        />,
      ),
    );
    const plain = mounted.container.querySelector<HTMLElement>(
      '[data-testid="source"]',
    )!;
    expect(plain.getAttribute('role')).not.toBe('link');
    act(() => plain.click());
    expect(open).toHaveBeenCalledOnce();
  } finally {
    mounted.unmount();
  }
});
