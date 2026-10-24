import { useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';

/** A returned answer longer than this many lines of its body text is clipped behind Show more. */
const RETURNED_ANSWER_BODY_LINES = 8;

/** How the asked session ended its answer: it answered, passed, or returned no answer. */
export type HappierReturnedAnswerOutcome =
  | 'answer'
  | 'pass'
  | 'failed'
  | 'cancelled'
  | 'terminal_no_result';

/** The exact question behind the answer, read by the caller only while it is disclosed. */
export type HappierReturnedAnswerQuestion =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; onRetry?: () => void }>
  | Readonly<{ status: 'asked'; onOpen?: () => void }>;

export type HappierReturnedAnswerQuoteLabels = Readonly<{
  outcome: Readonly<Record<HappierReturnedAnswerOutcome, string>>;
  open: string;
  information: string;
  yourQuestion: string;
  loading: string;
  askedFromHere: string;
  openQuestion: string;
  questionUnavailable: string;
  retry: string;
}>;

export type HappierReturnedAnswerQuoteTextProps = Readonly<{
  role: 'answerer' | 'meta';
  color: string;
  numberOfLines?: number;
  testID?: string;
  children: ReactNode;
}>;

export type HappierReturnedAnswerQuoteActionProps = Readonly<{
  label: string;
  onPress: () => void;
  expanded?: boolean;
  testID?: string;
}>;

export type HappierReturnedAnswerQuoteProps = Readonly<{
  testID?: string;
  /** The answering session's name. */
  answerer: string;
  outcome: HappierReturnedAnswerOutcome;
  /** The answer itself, drawn by the caller with its own content renderer. */
  children?: ReactNode;
  onOpenAnswerer?: () => void;
  /** Present when the caller can read the exact question; it owns the read and the disclosure state. */
  question?: Readonly<{
    open: boolean;
    onToggle: () => void;
    state: HappierReturnedAnswerQuestion;
  }>;
  labels: HappierReturnedAnswerQuoteLabels;
  /** The answerer's mark and the information glyph, in the caller's icon family. */
  answererMark?: ReactNode;
  informationMark?: ReactNode;
  Text: ComponentType<HappierReturnedAnswerQuoteTextProps>;
  Action: ComponentType<HappierReturnedAnswerQuoteActionProps>;
  colors: Readonly<{
    text: string;
    secondaryText: string;
    danger: string;
    border: string;
    /** The card's in-flow fill (the host's inset surface); without it the quote is a rail only. */
    surface?: string;
  }>;
  /** The card's corner; defaults to the shared card step. */
  radius?: number;
  /**
   * Bounds a long answer to a few lines of the caller's body text (`lineHeight`) with a Show more /
   * Show less control under it. The full answer stays reachable; an answer that fits is drawn whole.
   * `fade` is the caller's bottom-edge fade (its scroll-edge mask owner) applied while the answer is
   * clipped, so the clip never slices a line of text in half.
   */
  collapse?: Readonly<{ lineHeight: number; showMore: string; showLess: string; fade?: ViewStyle }>;
  space?: Readonly<Record<'s2' | 's6' | 's8' | 's10' | 's12', number>>;
}>;

/**
 * An answer another session returned to an Ask: quoted under the answerer's name and outcome, and
 * labelled as information, never as something the person wrote. Shared by core and plugins; the
 * caller admits the answer, reads the question and owns navigation.
 */
export function HappierReturnedAnswerQuote(
  props: HappierReturnedAnswerQuoteProps,
): ReactElement {
  const { Text, Action, colors, labels, question } = props;
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const failed = props.outcome !== 'answer' && props.outcome !== 'pass';
  const id = (part: string) =>
    props.testID ? `${props.testID}.${part}` : undefined;
  const row = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    minWidth: 0,
  } as const;
  return (
    <View
      testID={props.testID}
      style={{
        alignSelf: 'stretch',
        borderLeftWidth: 2,
        borderLeftColor: colors.border,
        borderRadius: props.radius ?? HAPPIER_RADIUS_V1.xl,
        backgroundColor: colors.surface,
        paddingHorizontal: space.s12,
        paddingVertical: space.s10,
        gap: space.s6,
        minWidth: 0,
      }}
    >
      <View style={row}>
        {props.answererMark}
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Text role="answerer" color={colors.text} numberOfLines={1}>
            {props.answerer}
          </Text>
        </View>
        <View style={{ flexShrink: 0 }}>
          <Text
            role="meta"
            color={failed ? colors.danger : colors.secondaryText}
            testID={id('outcome')}
          >
            {labels.outcome[props.outcome]}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        {props.onOpenAnswerer ? (
          <View style={{ flexShrink: 0 }}>
            <Action
              label={labels.open}
              onPress={props.onOpenAnswerer}
              testID={id('open')}
            />
          </View>
        ) : null}
      </View>
      {props.children ? (
        <ReturnedAnswerBody
          collapse={props.collapse}
          Action={Action}
          gap={space.s6}
          testID={id('body')}
        >
          {props.children}
        </ReturnedAnswerBody>
      ) : null}
      <View style={row}>
        {props.informationMark}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text role="meta" color={colors.secondaryText}>
            {labels.information}
          </Text>
        </View>
        {question ? (
          <Action
            label={labels.yourQuestion}
            onPress={question.onToggle}
            expanded={question.open}
            testID={id('question')}
          />
        ) : null}
      </View>
      {question?.open ? (
        <ReturnedAnswerQuestionLine
          state={question.state}
          labels={labels}
          Text={Text}
          Action={Action}
          color={colors.secondaryText}
          row={row}
          testID={id('questionState')}
        />
      ) : null}
    </View>
  );
}

/**
 * The answer, drawn whole when it fits a few lines of its body text and clipped to them when it does not.
 * The clip applies from the first paint, until the answer is measured, so a long answer never paints full length
 * first and shrinks on arrival.
 */
function ReturnedAnswerBody(
  props: Readonly<{
    collapse: HappierReturnedAnswerQuoteProps['collapse'];
    Action: ComponentType<HappierReturnedAnswerQuoteActionProps>;
    gap: number;
    testID?: string;
    children: ReactNode;
  }>,
): ReactElement {
  const { collapse, Action } = props;
  const [expanded, setExpanded] = useState(false);
  const [naturalHeight, setNaturalHeight] = useState(0);
  if (!collapse) return <View style={{ minWidth: 0 }}>{props.children}</View>;
  const maxHeight = RETURNED_ANSWER_BODY_LINES * collapse.lineHeight;
  const overflowing = naturalHeight > maxHeight;
  return (
    <View style={{ minWidth: 0, gap: props.gap }}>
      <View
        testID={props.testID}
        style={expanded ? { minWidth: 0 }
          : { minWidth: 0, maxHeight, overflow: 'hidden', ...(overflowing ? collapse.fade : null) }}
      >
        <View onLayout={(event) => setNaturalHeight(event.nativeEvent.layout.height)}>
          {props.children}
        </View>
      </View>
      {overflowing ? (
        <View style={{ alignSelf: 'flex-start' }}>
          <Action
            label={expanded ? collapse.showLess : collapse.showMore}
            expanded={expanded}
            onPress={() => setExpanded((value) => !value)}
            testID={props.testID ? `${props.testID}.fold` : undefined}
          />
        </View>
      ) : null}
    </View>
  );
}

function ReturnedAnswerQuestionLine(
  props: Readonly<{
    state: HappierReturnedAnswerQuestion;
    labels: HappierReturnedAnswerQuoteLabels;
    Text: ComponentType<HappierReturnedAnswerQuoteTextProps>;
    Action: ComponentType<HappierReturnedAnswerQuoteActionProps>;
    color: string;
    row: object;
    testID?: string;
  }>,
): ReactElement {
  const { state, labels, Text, Action } = props;
  const line =
    state.status === 'loading'
      ? labels.loading
      : state.status === 'unavailable'
        ? labels.questionUnavailable
        : labels.askedFromHere;
  const action =
    state.status === 'unavailable' && state.onRetry
      ? { label: labels.retry, onPress: state.onRetry }
      : state.status === 'asked' && state.onOpen
        ? { label: labels.openQuestion, onPress: state.onOpen }
        : null;
  return (
    <View testID={props.testID} style={props.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text role="meta" color={props.color}>
          {line}
        </Text>
      </View>
      {action ? <Action label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}
