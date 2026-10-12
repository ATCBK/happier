import { useState, type ComponentType, type ReactNode } from 'react';
import { View } from 'react-native';

import { HappierFormActions } from '../form/Fields.js';

/** One control of a link handover, drawn by the host's or the author surface's button. */
export type HappierLinkDeliveryButtonProps = Readonly<{
  label: string;
  /** `secondary` is the lead handover (Copy); `quiet` the others (Share, Show QR, Open). */
  emphasis: 'secondary' | 'quiet';
  /** Set on the toggle that shows the QR in place. */
  expanded?: boolean;
  onPress: () => unknown;
  testID?: string;
}>;

export type HappierLinkDeliveryBindings = Readonly<{
  Button: ComponentType<HappierLinkDeliveryButtonProps>;
  /**
   * The link as a QR code through the host's encoder, or the host's fallback when the payload is too
   * large for it. A host without a QR renderer returns null; the copyable link stays beside it.
   */
  renderQr: (
    input: Readonly<{
      url: string;
      accessibilityLabel: string;
      testID: string;
    }>,
  ) => ReactNode;
}>;

export type HappierLinkDeliveryProps = Readonly<{
  url: string;
  /** Distinguishes the surfaces that hand a link over, so a test can tell them apart. */
  testIDPrefix: string;
  copyLabel: string;
  qrAccessibilityLabel: string;
  /**
   * When supplied, the QR is an explicit toggle instead of an always-open panel: the compact form for a
   * link people open on this device. A link handed to someone else keeps its QR visible.
   */
  qrActionLabel?: string;
  /** Writes the link through the clipboard port; the caller owns failure copy and copied feedback. */
  onCopy: () => unknown;
  /** Present only where the platform can share text. */
  share?: Readonly<{ label: string; onPress: () => unknown }>;
  /** An in-app preview of where the link lands; only a link the person may open themselves offers one. */
  open?: Readonly<{ label: string; onPress: () => unknown }>;
  /** Quiet confirmation after a copy, at the end of the actions (the host's copied pill). */
  copiedIndicator?: ReactNode;
  bindings: HappierLinkDeliveryBindings;
}>;

/** The room the QR and its actions sit apart by; they wrap beneath each other on a narrow page. */
const LINK_DELIVERY_GAP_PX = 16;

/**
 * The handover of a link to a person (lab `tsInvites-K`): the QR beside the controls that copy, share,
 * show and open it, in one place, so every surface that hands a link over offers the same deliveries.
 *
 * Neutral by design: it never fetches, stores or logs the link. The caller owns the URL in memory for as
 * long as it may legitimately be shown, and owns what the link authorizes (an invitation bearer handed
 * over once stays in its host adapter). The link row and section frame are the caller's list owners.
 */
export function HappierLinkDelivery(props: HappierLinkDeliveryProps) {
  const [qrRevealed, setQrRevealed] = useState(
    props.qrActionLabel === undefined,
  );
  const { Button } = props.bindings;
  const prefix = props.testIDPrefix;
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: LINK_DELIVERY_GAP_PX,
      }}
    >
      {qrRevealed ? (
        <View style={{ alignSelf: 'center' }}>
          {props.bindings.renderQr({
            url: props.url,
            accessibilityLabel: props.qrAccessibilityLabel,
            testID: `${prefix}-qr`,
          })}
        </View>
      ) : null}
      <View style={{ flexGrow: 1, flexShrink: 1 }}>
        <HappierFormActions>
          <Button
            testID={`${prefix}-copy-link`}
            emphasis="secondary"
            label={props.copyLabel}
            onPress={props.onCopy}
          />
          {props.share ? (
            <Button
              testID={`${prefix}-share-link`}
              emphasis="quiet"
              label={props.share.label}
              onPress={props.share.onPress}
            />
          ) : null}
          {props.qrActionLabel ? (
            <Button
              testID={`${prefix}-show-qr`}
              emphasis="quiet"
              label={props.qrActionLabel}
              expanded={qrRevealed}
              onPress={() => setQrRevealed((visible) => !visible)}
            />
          ) : null}
          {props.open ? (
            <Button
              testID={`${prefix}-open`}
              emphasis="quiet"
              label={props.open.label}
              onPress={props.open.onPress}
            />
          ) : null}
          {props.copiedIndicator}
        </HappierFormActions>
      </View>
    </View>
  );
}
