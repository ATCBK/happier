import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { View } from 'react-native';

import { usePluginHostApi } from '../hostApi/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import {
  HappierLinkDelivery,
  type HappierLinkDeliveryBindings,
} from '../presentation/sharing/LinkDelivery.js';
import { HappierText } from '../presentation/text/Text.js';
import { Button } from './Button.js';
import { QRCode } from './Content.js';
import { Item, ItemGroup } from './List.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

const COPY_KEY = 'happier.plugin-ui.action.copy';
const OPEN_KEY = 'happier.plugin-ui.action.open';
const COPIED_KEY = 'happier.plugin-ui.action.copied';
/** How long "Copied" stays after a copy: long enough to read, gone before the next glance. */
const COPIED_VISIBLE_MS = 2_000;
const QR_SIZE_PX = 180;

export type LinkDeliveryProps = Readonly<{
  /** The link to hand over. It is rendered, never stored or sent anywhere by this component. */
  url: string;
  /** The section's title; omit it where the surrounding surface already names the link. */
  title?: string;
  titleKey?: string;
  /** What the link lets someone do, and for how long. */
  description?: string;
  descriptionKey?: string;
  copyLabel?: string;
  copyLabelKey?: string;
  /** Names the QR for a screen reader ("QR code for the pairing link"); `qrAccessibilityLabelKey` translates it. */
  qrAccessibilityLabel: string;
  qrAccessibilityLabelKey?: string;
  /**
   * Show the QR behind a toggle with this label instead of always. Use it for a link people open on this
   * device; keep the QR open for a link handed to another device.
   */
  qrActionLabel?: string;
  qrActionLabelKey?: string;
  /** Offer "Open" through the host's external-link owner. */
  openable?: boolean;
  openLabel?: string;
  openLabelKey?: string;
  testID?: string;
}>;

/**
 * Hand a link to a person: the link in one line, its QR beside the buttons that copy and open it — the
 * same composition Happier uses for its own sign-in and pairing links. Copy goes through the host's
 * clipboard owner and Open through its external-link owner; the QR is drawn by the host's encoder and
 * absent where the host has none, so the copyable link always stays beside it.
 */
export function LinkDelivery(props: LinkDeliveryProps): ReactElement {
  const translate = usePluginTranslation();
  const hostApi = usePluginHostApi();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const { url } = props;
  const prefix = props.testID ?? 'link-delivery';
  const copy = useCallback(async () => {
    await hostApi.writeClipboard(url);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_VISIBLE_MS);
  }, [hostApi, url]);
  const open = useCallback(() => hostApi.openExternalLink(url), [hostApi, url]);
  const text = (value: string | undefined, key: string | undefined) => resolveAuthorText(translate, value, key);
  return (
    <ItemGroup title={text(props.title, props.titleKey)} description={text(props.description, props.descriptionKey)} testID={props.testID}>
      <Item testID={`${prefix}-link`}>
        <HappierText variant="code" numberOfLines={1} selectable>{url}</HappierText>
      </Item>
      <Item>
        <HappierLinkDelivery
          url={url}
          testIDPrefix={prefix}
          copyLabel={text(props.copyLabel, props.copyLabelKey) ?? translate(COPY_KEY, 'Copy')}
          qrAccessibilityLabel={text(props.qrAccessibilityLabel, props.qrAccessibilityLabelKey) ?? props.qrAccessibilityLabel}
          qrActionLabel={text(props.qrActionLabel, props.qrActionLabelKey)}
          onCopy={copy}
          open={props.openable ? { label: text(props.openLabel, props.openLabelKey) ?? translate(OPEN_KEY, 'Open'), onPress: open } : undefined}
          copiedIndicator={copied ? (
            <HappierText testID={`${prefix}-copied`} variant="meta" tone="secondary" accessibilityLiveRegion="polite">
              {translate(COPIED_KEY, 'Copied')}
            </HappierText>
          ) : null}
          bindings={LINK_DELIVERY_BINDINGS}
        />
      </Item>
    </ItemGroup>
  );
}

const LINK_DELIVERY_BINDINGS: HappierLinkDeliveryBindings = {
  Button: (button) => (
    <Button
      testID={button.testID}
      title={button.label}
      size="small"
      variant={button.emphasis === 'secondary' ? 'secondary' : 'plain'}
      onPress={button.onPress}
    />
  ),
  renderQr: (qr) => <LinkQr url={qr.url} accessibilityLabel={qr.accessibilityLabel} testID={qr.testID} />,
};

/** The host's QR, named for a screen reader; nothing at all where the host draws no QR. */
function LinkQr(props: Readonly<{ url: string; accessibilityLabel: string; testID: string }>): ReactElement | null {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderQRCode) return null;
  return (
    <View accessible accessibilityLabel={props.accessibilityLabel}>
      <QRCode data={props.url} size={QR_SIZE_PX} testID={props.testID} />
    </View>
  );
}
