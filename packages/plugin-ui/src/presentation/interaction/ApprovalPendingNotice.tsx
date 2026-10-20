import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierBanner } from '../content/Foundation.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';

export type HappierNoticeLineTextRender = (
  input: Readonly<{
    role: 'subject' | 'title';
    text: string;
    style: HappierStyleProp;
    testID?: string;
  }>,
) => ReactNode;

export type HappierNoticeLineProps = Readonly<{
  /** The line's glyph, sized and tinted by the host (an info mark, a warning mark). */
  icon: ReactNode;
  /** What the line is about ("DeepSeek V4 Pro"). It gives way first, so the status stays readable. */
  subject?: string | null;
  /** The status itself ("Waiting for approval"). */
  title: string;
  /** One quiet way forward at the line's end (Open, Retry). */
  action?: ReactNode;
  theme: HappierUiTheme;
  testID?: string;
  /** A same-realm host binds its own text owner (font scaling); the layout stays this owner's. */
  renderText?: HappierNoticeLineTextRender;
}>;

// The line sits among a picker's other status lines: one meta step, the glyph and the words a
// breath apart, the subject a hair closer to the status it belongs to.
const LINE_GAP = 6;
const SUBJECT_GAP = 4;
const LINE_MIN_HEIGHT = 24;

const renderDefaultText: HappierNoticeLineTextRender = (input) => (
  <HappierText testID={input.testID} numberOfLines={1} style={input.style}>
    {input.text}
  </HappierText>
);

/**
 * One compact status line: glyph, subject · status, and one way forward. On one line when it fits;
 * when it does not, the status drops beneath the subject rather than squeezing the subject to a stub
 * (each part still truncates alone if it is wider than the line).
 */
export function HappierNoticeLine(props: HappierNoticeLineProps) {
  const typography = useOptionalHappierUiTypography();
  const renderText = props.renderText ?? renderDefaultText;
  const textStyle = {
    ...resolveHappierTypeRoleStyle('meta', props.theme, typography),
    color: props.theme.colors.secondaryText,
  };
  const subject = props.subject?.trim() || null;
  return (
    <View
      testID={props.testID}
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: LINE_GAP,
        minHeight: LINE_MIN_HEIGHT,
      }}
    >
      <View
        style={{
          minHeight: LINE_MIN_HEIGHT,
          justifyContent: 'center',
        }}
      >
        {props.icon}
      </View>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: LINE_MIN_HEIGHT,
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignContent: 'center',
          columnGap: SUBJECT_GAP,
        }}
      >
        {subject
          ? renderText({
              role: 'subject',
              text: subject,
              testID: props.testID ? `${props.testID}.subject` : undefined,
              style: [textStyle, { flexShrink: 1, maxWidth: '100%' }],
            })
          : null}
        {/* The separator is its own item so a status that drops beneath the subject never starts a line with it. */}
        {subject
          ? renderText({
              role: 'title',
              text: '·',
              style: [textStyle, { flexShrink: 0 }],
            })
          : null}
        {renderText({
          role: 'title',
          text: props.title,
          style: [textStyle, { flexShrink: 1, maxWidth: '100%' }],
        })}
      </View>
      {props.action ? (
        <View style={{ minHeight: LINE_MIN_HEIGHT, justifyContent: 'center' }}>
          {props.action}
        </View>
      ) : null}
    </View>
  );
}

export type HappierApprovalPendingNoticeTextRender = (
  input: Readonly<{
    role: 'subject' | 'title' | 'description';
    text: string;
    style: HappierStyleProp;
    testID?: string;
  }>,
) => ReactNode;

export type HappierApprovalPendingNoticeProps = Readonly<{
  /**
   * `banner`: the one notice a page shows above what is waiting. `line`: the compact form among a
   * picker's or bar's other status lines; it names the subject that waits.
   */
  presentation: 'banner' | 'line';
  /** What is waiting ("DeepSeek V4 Pro", "Write docs/getting-started.md"). The line names it first. */
  subject?: string | null;
  /** The waiting state ("Waiting for approval"). */
  title: string;
  /** The banner's one sentence beneath the title (what finishes once it is approved). */
  description?: string | null;
  /**
   * The way to the approval: the host's control (a button on the banner, a quiet icon button on the
   * line). Opening the approval belongs to the host; this owner only places it.
   */
  open: ReactNode;
  /** The notice glyph, sized and tinted by the host. */
  icon: ReactNode;
  theme: HappierUiTheme;
  /** The banner's tint and hairline when the host has its own neutral-state colours. */
  tint?: Readonly<{ background: string; border: string }> | null;
  testID?: string;
  renderText?: HappierApprovalPendingNoticeTextRender;
}>;

/**
 * A request waiting for someone's approval: what waits, that it waits, and the way to the approval.
 * Controlled presentation only. The request's own continuation settles it; nothing here approves,
 * polls or retries.
 */
export function HappierApprovalPendingNotice(
  props: HappierApprovalPendingNoticeProps,
) {
  if (props.presentation === 'line') {
    return (
      <HappierNoticeLine
        testID={props.testID}
        icon={props.icon}
        subject={props.subject}
        title={props.title}
        action={props.open}
        theme={props.theme}
        renderText={props.renderText}
      />
    );
  }
  const description = props.description?.trim() || null;
  return (
    <HappierBanner
      testID={props.testID}
      // Waiting on someone is neutral: not a failure, not a caution.
      tone="neutral"
      theme={props.theme}
      title={props.title}
      description={description ?? undefined}
      announce="none"
      accessibilityLiveRegion="polite"
      icon={props.icon}
      backgroundColor={props.tint?.background}
      borderColor={props.tint?.border}
      titleContent={
        props.renderText
          ? props.renderText({ role: 'title', text: props.title, style: {} })
          : undefined
      }
      descriptionContent={
        props.renderText && description
          ? props.renderText({
              role: 'description',
              text: description,
              style: {},
            })
          : undefined
      }
      action={props.open}
    />
  );
}
