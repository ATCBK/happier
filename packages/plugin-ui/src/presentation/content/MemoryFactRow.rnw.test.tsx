import { act, type ReactNode } from 'react';
import { Text } from 'react-native';
import { expect, it, vi } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';

import * as publicUi from '../../components/index.js';
import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createPluginUiRnwSemanticSurfaceAdapter } from '../../testing/index.js';
import { renderSurface } from '../../../fixtures/external-authoring/src/memoryFactsSurface.js';

function surface(children: ReactNode) {
  return <HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContext())}>
    {children}
  </HappierUiEnvironmentProvider>;
}

it('composes a caller-owned memory fact with an independent source link and actions', async () => {
  const open = vi.fn();
  const edit = vi.fn();
  const mounted = mountThroughReactNativeWeb(surface(
    <publicUi.HappierMemoryFactRow testID="fact" text="Prefer small patches" metadata="Oct 14"
      source={{ label: 'Review session', accessibilityLabel: 'Open source session', onPress: open }}
      actions={<publicUi.Button title="Edit fact" onPress={edit} />} />,
  ));
  try {
    expect(mounted.container.textContent).toContain('Prefer small patches');
    expect(mounted.container.textContent).toContain('Oct 14 · Review session');
    const link = mounted.container.querySelector<HTMLElement>('[data-testid="fact.source"]')!;
    expect(link.getAttribute('role')).toBe('link');
    expect(link.getAttribute('aria-label')).toBe('Open source session');
    act(() => link.click());
    expect(open).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
    act(() => mounted.container.querySelector<HTMLElement>('[role="button"][aria-label="Edit fact"]')!.click());
    expect(edit).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    await mounted.render(surface(
      <publicUi.HappierMemoryFactRow testID="fact" text="Prefer small patches" metadata="Oct 14"
        source={{ label: 'Review session', accessibilityLabel: 'Open source session' }} />,
    ));
    expect(mounted.container.textContent).toContain('Oct 14 · Review session');
    expect(mounted.container.querySelector('[role="link"]')).toBeNull();
    expect(mounted.container.querySelector('[role="button"]')).toBeNull();
  } finally { mounted.unmount(); }
});

it('keeps a decision reason on its own line so the metadata and source link stay readable', () => {
  const mounted = mountThroughReactNativeWeb(surface(
    <publicUi.HappierMemoryFactRow testID="fact" text="Retry cap: 5 attempts" metadata="Decision · approved by you"
      detail="Deploys drain connections for up to 8 s before the relay restarts, so 400 ms backoff ran out too early."
      source={{ label: 'Retry cap during deploys', accessibilityLabel: 'Open source session', onPress: () => {} }} />,
  ));
  try {
    const detail = mounted.container.querySelector<HTMLElement>('[data-testid="fact.detail"]')!;
    expect(detail.textContent).toBe('Deploys drain connections for up to 8 s before the relay restarts, so 400 ms backoff ran out too early.');
    // The reason is not folded into the one-line metadata, which keeps the approval and the link.
    const link = mounted.container.querySelector<HTMLElement>('[data-testid="fact.source"]')!;
    expect(link.parentElement?.textContent).toBe('Decision · approved by you · Retry cap during deploys');
  } finally { mounted.unmount(); }
});

it('opens a fact from its row while the source link keeps opening only the source', () => {
  const openFact = vi.fn();
  const openSource = vi.fn();
  const mounted = mountThroughReactNativeWeb(surface(
    <publicUi.HappierMemoryFactRow testID="fact" text="Retry cap: 5 attempts" metadata="Decision" selected
      onPress={openFact}
      source={{ label: 'Retry cap during deploys', accessibilityLabel: 'Open source session', onPress: openSource }} />,
  ));
  try {
    act(() => mounted.container.querySelector<HTMLElement>('[data-testid="fact.source"]')!.click());
    expect(openSource).toHaveBeenCalledOnce();
    expect(openFact).not.toHaveBeenCalled();
    act(() => mounted.container.querySelector<HTMLElement>('[data-testid="fact"]')!.click());
    expect(openFact).toHaveBeenCalledOnce();
    expect(openSource).toHaveBeenCalledOnce();
  } finally { mounted.unmount(); }
});

it('preserves host row bindings and arrival content across active, expired and archived facts', async () => {
  const rows: publicUi.HappierMemoryFactItemProps[] = [];
  const host: publicUi.HappierMemoryFactRowHost = {
    Row: props => { rows.push(props); return <Text>{props.text}{props.subtitle}</Text>; },
    Metadata: props => <Text>{props.children}</Text>,
    Source: props => <Text {...props} />,
  };
  const mounted = mountThroughReactNativeWeb(surface(
    <publicUi.HappierMemoryFactRow testID="fact" text="A fact" metadata="Just now" host={host}
      arrival={<Text>New fact</Text>} />,
  ));
  try {
    expect(rows.at(-1)).toMatchObject({ archived: false, retired: false });
    expect(mounted.container.textContent).toContain('New fact');
    await mounted.render(surface(<publicUi.HappierMemoryFactRow testID="fact" text="A fact" metadata="Expired"
      expired host={host} />));
    expect(rows.at(-1)).toMatchObject({ archived: false, retired: true });
    await mounted.render(surface(<publicUi.HappierMemoryFactRow testID="fact" text="A fact" metadata="Archived"
      archived host={host} />));
    expect(rows.at(-1)).toMatchObject({ archived: true, retired: true });
    expect(mounted.container.textContent).not.toContain('New fact');
  } finally { mounted.unmount(); }
});

it('mounts the public-only author fixture through the production surface wrapper', async () => {
  const page = await createPluginUiTestkit({ identity: { instanceId: 'memory-facts', mountNonce: 'public' },
    authorPlugin: { id: 'example.memory-facts', version: '0.0.0' }, surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(), surface: renderSurface });
  try {
    await act(async () => { await page.press(await page.getByRole('link', { name: 'Open source session' })); });
    await expect(page.getByText('Opened source')).resolves.toBeDefined();
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Edit fact' })); });
    await expect(page.getByText('Opened edit')).resolves.toBeDefined();
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Open review habits' })); });
    await expect(page.getByText('Opened topic')).resolves.toBeDefined();
  } finally { await page.dispose(); }
});
