import type { ComponentType, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';

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
  }>;
  space?: Readonly<Record<'s2' | 's6' | 's8' | 's12', number>>;
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
        paddingLeft: space.s12,
        paddingVertical: space.s2,
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
        <Text
          role="meta"
          color={failed ? colors.danger : colors.secondaryText}
          numberOfLines={1}
          testID={id('outcome')}
        >
          {labels.outcome[props.outcome]}
        </Text>
        <View style={{ flex: 1 }} />
        {props.onOpenAnswerer ? (
          <Action
            label={labels.open}
            onPress={props.onOpenAnswerer}
            testID={id('open')}
          />
        ) : null}
      </View>
      {props.children ? (
        <View style={{ minWidth: 0 }}>{props.children}</View>
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
