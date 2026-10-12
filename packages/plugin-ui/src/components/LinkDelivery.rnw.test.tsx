import type { ReactNode } from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { PluginUiProvider, PluginUiProviderInternal } from './PluginUiProvider.js';
import { LinkDelivery } from './index.js';

const PAIRING_URL = 'https://example.test/pair/abc123';

function mount(children: ReactNode, presentationHost?: Partial<PluginUiPresentationHost>) {
  const context = createSurfaceContext();
  const hostApi = createHostApiStub(context);
  const calls: { clipboard: string[]; opened: string[] } = { clipboard: [], opened: [] };
  const recordingHost = {
    ...hostApi,
    writeClipboard: async (value: string) => { calls.clipboard.push(value); },
    openExternalLink: async (url: string) => { calls.opened.push(url); },
  };
  const tree = presentationHost
    ? <PluginUiProviderInternal hostApi={recordingHost} context={context} presentationHost={{ renderMarkdown: () => null, renderPopover: () => null, renderIcon: () => null, ...presentationHost } as unknown as PluginUiPresentationHost}>{children}</PluginUiProviderInternal>
    : <PluginUiProvider hostApi={recordingHost} context={context}>{children}</PluginUiProvider>;
  return { ...mountThroughReactNativeWeb(tree), calls };
}

/** The neutral link handover authors reach; host ports carry every effect, nothing else sees the link. */
describe('LinkDelivery: hand a link to a person through host ports', () => {
  it('copies and opens through the host owners and confirms the copy', async () => {
    const view = mount(<LinkDelivery testID="pair" url={PAIRING_URL} qrAccessibilityLabel="Pairing QR" openable />);
    expect(view.container.querySelector('[data-testid="pair-link"]')?.textContent).toBe(PAIRING_URL);
    await act(async () => { view.container.querySelector<HTMLElement>('[data-testid="pair-copy-link"]')?.click(); });
    expect(view.calls.clipboard).toEqual([PAIRING_URL]);
    expect(view.container.querySelector('[data-testid="pair-copied"]')).not.toBeNull();
    await act(async () => { view.container.querySelector<HTMLElement>('[data-testid="pair-open"]')?.click(); });
    expect(view.calls.opened).toEqual([PAIRING_URL]);
    // No share port exists for plugin surfaces, so no Share control is offered.
    expect(view.container.querySelector('[data-testid="pair-share-link"]')).toBeNull();
    view.unmount();
  });

  it('draws the host QR beside the actions, behind a toggle when asked, and nothing where the host has no encoder', async () => {
    const requests: string[] = [];
    const host = { renderQRCode: (request: { data: string; testID?: string }) => { requests.push(request.data); return <div data-testid={request.testID} />; } };
    const open = mount(<LinkDelivery testID="pair" url={PAIRING_URL} qrAccessibilityLabel="Pairing QR" />, host);
    expect(open.container.querySelector('[data-testid="pair-qr"]')).not.toBeNull();
    expect(requests).toEqual([PAIRING_URL]);
    open.unmount();

    const toggled = mount(<LinkDelivery testID="pair" url={PAIRING_URL} qrAccessibilityLabel="Pairing QR" qrActionLabel="Show QR" />, host);
    expect(toggled.container.querySelector('[data-testid="pair-qr"]')).toBeNull();
    await act(async () => { toggled.container.querySelector<HTMLElement>('[data-testid="pair-show-qr"]')?.click(); });
    expect(toggled.container.querySelector('[data-testid="pair-qr"]')).not.toBeNull();
    toggled.unmount();

    const bare = mount(<LinkDelivery testID="pair" url={PAIRING_URL} qrAccessibilityLabel="Pairing QR" />);
    expect(bare.container.querySelector('[aria-label="Pairing QR"]')).toBeNull();
    expect(bare.container.querySelector('[data-testid="pair-copy-link"]')).not.toBeNull();
    bare.unmount();
  });
});
