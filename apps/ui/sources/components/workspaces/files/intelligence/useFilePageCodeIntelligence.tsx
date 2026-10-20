import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { LanguageIntelligenceDiagnostic } from '@happier-dev/protocol/machines/languageIntelligence';

import type { DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { useOptionalUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import type { WorkspaceSymbolSearchInput } from '@/components/appShell/search/workspaceSymbolSearchSource';
import type {
  Rect,
  TextEditorHandle,
} from '@/components/ui/code/editor/codeEditorTypes';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { FileCodeIntelligenceBinding } from '@/components/workspaces/files/file/FileContentPanel';
import {
  useWorkspaceFileOpener,
  type WorkspaceFileOpenTarget,
} from '@/components/workspaces/files/useWorkspaceFileOpener';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { useWorkspaceRefs } from '@/sync/store/hooks';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { askCodeDiagnosticsToFix } from '@/sync/domains/workspaces/languageIntelligence/askCodeDiagnosticsToFix';
import { selectCodeDiagnostics } from '@/sync/domains/workspaces/languageIntelligence/codeDiagnostics';
import type { CodeIdentifier } from '@/sync/domains/workspaces/languageIntelligence/codeIdentifiers';
import type {
  CodeIntelligenceController,
  CodeIntelligenceSnapshot,
} from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import {
  useCodeIntelligence,
  useCodeIntelligenceSnapshot,
} from '@/sync/domains/workspaces/languageIntelligence/useCodeIntelligence';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { motionTokens } from '@/components/ui/motion/motionTokens';

import {
  CodeIntelligenceCard,
  CodeProblemsSheet,
  type CodeIntelligenceCardModel,
} from './CodeIntelligenceCard';
import {
  formatProblemsFact,
  readCodeHoverContent,
  readLanguageServerLabel,
  resolveLanguageStateNote,
} from './codeIntelligencePresentation';
import {
  publishCodeIntelligencePaneProducer,
  type CodeIntelligencePaneProducer,
} from './codeIntelligencePaneStore';
import type { CodeReferenceRow } from './CodeReferencesList';

type CardState = Readonly<{
  anchor: Rect | null;
  via: 'hover' | 'tap' | 'command';
  references: boolean;
  /** Phones: Problems open as a sheet from the meta fact (L3 `ls2-P`). */
  problems?: boolean;
}>;

/**
 * The File page's pointer and card state, outside React: pointer motion never re-renders the page.
 * Only the card leaf subscribes to it.
 */
function createCardInteraction() {
  let state: CardState | null = null;
  let dwell: ReturnType<typeof setTimeout> | null = null;
  let away: ReturnType<typeof setTimeout> | null = null;
  let cardHovered = false;
  let remembered: Rect | null = null;
  const listeners = new Set<() => void>();
  const set = (next: CardState | null) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const clearTimers = () => {
    if (dwell) clearTimeout(dwell);
    if (away) clearTimeout(away);
    dwell = null;
    away = null;
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (next: CardState) => {
      clearTimers();
      set(next);
    },
    close: () => {
      clearTimers();
      cardHovered = false;
      set(null);
    },
    /** A pointer resting on a name asks once it has rested (`overlay.popover.hoverOpenDelayMs`). */
    dwell: (run: () => void) => {
      if (away) {
        clearTimeout(away);
        away = null;
      }
      if (dwell) clearTimeout(dwell);
      dwell = setTimeout(() => {
        dwell = null;
        run();
      }, motionTokens.overlay.popover.hoverOpenDelayMs);
    },
    /** The pointer left the name: a hover card leaves too unless the pointer moved onto it. */
    leave: () => {
      if (dwell) {
        clearTimeout(dwell);
        dwell = null;
      }
      if (state?.via !== 'hover' || away) return;
      away = setTimeout(() => {
        away = null;
        if (!cardHovered && state?.via === 'hover') set(null);
      }, motionTokens.overlay.popover.hoverOpenDelayMs);
    },
    setCardHovered: (hovered: boolean) => {
      cardHovered = hovered;
      if (!hovered && state?.via === 'hover') {
        if (away) clearTimeout(away);
        away = setTimeout(() => {
          away = null;
          if (!cardHovered) set(null);
        }, motionTokens.overlay.popover.hoverOpenDelayMs);
      }
    },
    /** Where the last explicit gesture happened, for a card that answers it later (outside definitions). */
    remember: (anchor: Rect | null) => {
      remembered = anchor;
    },
    remembered: () => remembered,
    dispose: () => {
      clearTimers();
      listeners.clear();
    },
  };
}
type CardInteraction = ReturnType<typeof createCardInteraction>;

export type UseFilePageCodeIntelligenceInput = Readonly<{
  scopeId: string;
  scope: WorkspaceScopeBase | null;
  filePath: string;
  language: string | null;
  /** Text files that a person reads or edits; binary, partial and deleted files have no language features. */
  enabled: boolean;
  active: boolean;
  liveValue: Readonly<{
    get(): string;
    subscribe?(listener: () => void): () => void;
  }>;
  getUnsaved: () => boolean;
  editorHandleRef: React.RefObject<TextEditorHandle | null>;
  sessionId: string | null;
  accountId: string | null;
  machineName: string;
  machineUnreachable: boolean;
  agentName: string | null;
  /** P4's save of this page's buffer; resolves false when nothing was saved. */
  saveFileEdits: () => Promise<unknown> | unknown;
  readSavedText: () => Readonly<{ savedText: string; unsaved: boolean }>;
}>;

/** One stable selection of the controller's snapshot, re-rendering its caller only when `select` changes. */
function useControllerSelector<T>(
  controller: CodeIntelligenceController | null,
  select: (snapshot: CodeIntelligenceSnapshot) => T,
  key: (value: T) => string,
): T | null {
  const cache = React.useRef<{
    snapshot: CodeIntelligenceSnapshot | null;
    value: T | null;
    key: string;
  }>({ snapshot: null, value: null, key: '' });
  const getSnapshot = React.useCallback(() => {
    const snapshot = controller?.getSnapshot() ?? null;
    if (!snapshot) return null;
    if (cache.current.snapshot === snapshot) return cache.current.value;
    const value = select(snapshot);
    const nextKey = key(value);
    cache.current = {
      snapshot,
      value: nextKey === cache.current.key ? cache.current.value : value,
      key: nextKey,
    };
    return cache.current.value;
  }, [controller, select, key]);
  const subscribe = React.useCallback(
    (listener: () => void) =>
      controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, () => null);
}

const selectSummary = (snapshot: CodeIntelligenceSnapshot) => snapshot;

/**
 * P7's File page composition (N5: regions handed to the PAGE owner): the one controller, the read
 * view's pointer binding, the "3 problems" fact, the language state note, the card leaf, the `⋯`
 * commands, `@` symbols for Search and the References / Problems producer for the pane.
 */
export function useFilePageCodeIntelligence(
  input: UseFilePageCodeIntelligenceInput,
) {
  const { theme } = useUnistyles();
  const latest = React.useRef(input);
  latest.current = input;
  const opener = useWorkspaceFileOpener();
  const workspaceRefs = useWorkspaceRefs();
  const pane = useAppPaneScope(input.scopeId);
  const mainColumn = usePaneMainColumn();
  const phone = useDeviceType() === 'phone';
  const searchRuntime = useOptionalUniversalSearchRuntime();
  const interaction = React.useMemo(() => createCardInteraction(), []);
  React.useEffect(() => () => interaction.dispose(), [interaction]);

  const workspaceRefId = React.useMemo(
    () =>
      input.scope
        ? (findWorkspaceRefByScope(workspaceRefs, input.scope)?.id ?? null)
        : null,
    [input.scope, workspaceRefs],
  );
  const fileTarget = React.useMemo<Omit<
    WorkspaceFileOpenTarget,
    'path'
  > | null>(() => {
    if (!input.scope) return null;
    if (workspaceRefId)
      return {
        kind: 'project',
        workspaceRefId,
        serverId: input.scope.serverId,
        machineId: input.scope.machineId,
        rootPath: input.scope.rootPath,
      };
    return input.sessionId
      ? {
          kind: 'session',
          sessionId: input.sessionId,
          serverId: input.scope.serverId,
        }
      : null;
  }, [input.scope, input.sessionId, workspaceRefId]);
  const fileTargetRef = React.useRef(fileTarget);
  fileTargetRef.current = fileTarget;

  const openLocation = React.useCallback(
    async (
      location: Readonly<{
        path: string;
        range: Readonly<{ start: Readonly<{ line: number }> }>;
      }>,
    ) => {
      const target = fileTargetRef.current;
      if (!target) return;
      await opener.open(
        { ...target, path: location.path } as WorkspaceFileOpenTarget,
        {
          intent: 'preview',
          anchor: {
            kind: 'fileLine',
            startLine: location.range.start.line + 1,
          },
        },
      );
    },
    [opener],
  );

  const showProblems = React.useCallback(() => {
    if (phone)
      interaction.open({ anchor: null, via: 'command', references: false, problems: true });
    else pane.openRight({ tabId: 'problems' });
  }, [interaction, pane, phone]);

  const { controller, bindEditor } = useCodeIntelligence({
    scope: input.enabled ? input.scope : null,
    path: input.filePath,
    languageId: input.language,
    active: input.active,
    liveValue: input.liveValue,
    getUnsaved: input.getUnsaved,
    editorHandleRef: input.editorHandleRef,
    openLocation,
    showProblems,
  });

  // The pointer's name changed: ask about it once the pointer rests (both the read view and the editor).
  React.useEffect(() => {
    if (!controller) return;
    let previous = controller.getSnapshot().selection;
    return controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      const selection = snapshot.selection;
      if (selection === previous) return;
      previous = selection;
      const state = interaction.getState();
      if (state && state.via !== 'hover') return;
      // Phones have no hover; a tap asks instead.
      if (phone) return;
      if (!selection?.anchor) {
        interaction.leave();
        return;
      }
      const anchor = selection.anchor;
      interaction.dwell(() => {
        if (controller.getSnapshot().selection !== selection) return;
        interaction.open({ anchor, via: 'hover', references: false });
        void controller.hover(selection.position);
      });
    });
  }, [controller, interaction, phone]);

  // Shift+F12 and Find references: desktop shows the References tab, a phone grows them in the sheet.
  React.useEffect(() => {
    if (!controller) return;
    let previousKind = controller.getSnapshot().kind;
    let previousQuery = controller.getSnapshot().querySelection;
    return controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      const changed =
        snapshot.kind !== previousKind ||
        snapshot.querySelection !== previousQuery;
      previousKind = snapshot.kind;
      previousQuery = snapshot.querySelection;
      if (!changed) return;
      if (snapshot.kind === 'references') {
        if (phone)
          interaction.open({
            anchor: interaction.getState()?.anchor ?? null,
            via: 'tap',
            references: true,
          });
        else {
          interaction.close();
          pane.openRight({ tabId: 'references' });
        }
      }
      if (
        snapshot.kind === 'definition' &&
        snapshot.status === 'ready' &&
        snapshot.result &&
        'locations' in snapshot.result &&
        snapshot.result.locations.length > 0 &&
        snapshot.result.locations.every(
          (location) =>
            'outsideWorkspace' in location && location.outsideWorkspace,
        )
      ) {
        interaction.open({
          anchor:
            interaction.getState()?.anchor ??
            interaction.remembered() ??
            snapshot.querySelection?.anchor ??
            null,
          via: 'command',
          references: false,
        });
      }
    });
  }, [controller, interaction, pane, phone]);

  const viewBinding = React.useMemo<FileCodeIntelligenceBinding | null>(
    () =>
      controller
        ? {
            onPointer: (line, character, rect) =>
              controller.inspect({
                line: line - 1,
                character,
                ...(rect ? { anchor: rect } : {}),
              }),
            onPointerAway: () => {
              controller.inspect(null);
              interaction.leave();
            },
            onActivate: (line, character, activation) => {
              const position = { line: line - 1, character };
              if (activation.via === 'touch') {
                controller.inspect({
                  ...position,
                  ...(activation.rect ? { anchor: activation.rect } : {}),
                });
                interaction.open({
                  anchor: activation.rect,
                  via: 'tap',
                  references: false,
                });
                void controller.hover(position);
                return;
              }
              interaction.close();
              interaction.remember(activation.rect);
              void controller.definition(position);
            },
          }
        : null,
    [controller, interaction],
  );

  const snapshotForPage = useControllerSelector(
    controller,
    selectSummary,
    React.useCallback(
      (snapshot: CodeIntelligenceSnapshot) => {
        const note = resolveLanguageStateNote({
          snapshot,
          machineName: latest.current.machineName,
          machineUnreachable: latest.current.machineUnreachable,
        });
        const file = selectCodeDiagnostics(
          controller?.getDiagnosticsProjection() ?? {
            revision: -1,
            entries: {},
          },
          latest.current.filePath,
        );
        return JSON.stringify([
          note?.kind === 'failure' ? note.text : null,
          file.state,
          file.count,
          snapshot.diagnostics?.count ?? null,
          snapshot.diagnostics?.state ?? null,
        ]);
      },
      [controller],
    ),
  );
  const failureNote = snapshotForPage
    ? resolveLanguageStateNote({
        snapshot: snapshotForPage,
        machineName: input.machineName,
        machineUnreachable: input.machineUnreachable,
      })
    : null;
  const fileProblems = controller
    ? selectCodeDiagnostics(
        controller.getDiagnosticsProjection(),
        input.filePath,
      )
    : null;
  const problemsText = fileProblems
    ? formatProblemsFact({
        count: fileProblems.count,
        state: fileProblems.state,
        errors: fileProblems.items.filter((item) => item.severity === 'error')
          .length,
      })
    : null;
  const headerFacts = React.useMemo<readonly DetailsTabHeaderMetaFact[]>(
    () =>
      problemsText
        ? [
            {
              key: 'problems',
              text: problemsText,
              tone: 'failure',
              onPress: showProblems,
              testID: 'file-details-problems-fact',
              accessibilityLabel: t('files.pane.intelligence.showProblems'),
            },
          ]
        : [],
    [problemsText, showProblems],
  );

  const restart = React.useCallback(() => {
    void controller?.restart();
  }, [controller]);
  const notice =
    failureNote?.kind === 'failure' ? (
      <SurfaceFreshnessLine
        testID="file-language-state-note"
        tone="warning"
        reason={
          failureNote.detail
            ? `${failureNote.text} ${failureNote.detail}`
            : failureNote.text
        }
        action={
          failureNote.action === 'restart'
            ? { label: t('files.pane.intelligence.restart'), onPress: restart }
            : undefined
        }
      />
    ) : null;

  // Ask {agent} to fix N problems (P5's Ask owner, one batch); unsaved-only problems save first.
  const allProblems = snapshotForPage?.diagnostics ?? null;
  const unsaved = input.getUnsaved();
  const askCount =
    allProblems?.state === 'ready' ? (allProblems.count ?? 0) : 0;
  const askLabel =
    askCount > 0
      ? input.agentName
        ? unsaved
          ? t('files.pane.intelligence.saveAndAskAgent', {
              agent: input.agentName,
              count: askCount,
            })
          : t('files.pane.intelligence.askAgent', {
              agent: input.agentName,
              count: askCount,
            })
        : unsaved
          ? t('files.pane.intelligence.saveAndAsk', { count: askCount })
          : t('files.pane.intelligence.ask', { count: askCount })
      : null;
  const askToFix = React.useCallback(async (): Promise<boolean> => {
    const current = latest.current;
    if (!controller || !current.scope) return false;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const owner = controller;
    const result = await askCodeDiagnosticsToFix({
      projection: owner.getDiagnosticsProjection(),
      workspaceScope: current.scope,
      sessionTarget: current.sessionId
        ? {
            sessionId: current.sessionId,
            revealSessionColumn: () => {
              if (mainColumn?.hidden) mainColumn.setHidden(false);
            },
          }
        : null,
      isCurrent: () =>
        latestController.current === owner && (lifetime?.isCurrent() ?? true),
      readFile: async (path) =>
        path === latest.current.filePath
          ? latest.current.readSavedText()
          : { savedText: '', unsaved: false },
      saveFileEdits: async (path) => {
        if (path !== latest.current.filePath) return false;
        const saved = await latest.current.saveFileEdits();
        return saved !== false;
      },
    });
    return result.created > 0;
  }, [controller, mainColumn]);
  const latestController = React.useRef(controller);
  latestController.current = controller;

  const openReference = React.useCallback(
    (row: CodeReferenceRow) => {
      void openLocation({
        path: row.path,
        range: { start: { line: row.line } },
      });
    },
    [openLocation],
  );
  const openProblem = React.useCallback(
    (item: LanguageIntelligenceDiagnostic) => {
      void openLocation(item);
    },
    [openLocation],
  );

  // The pane's References / Problems tabs read this page while it is the active one.
  const askModel = React.useMemo(
    () => (askLabel ? { label: askLabel, run: askToFix } : null),
    [askLabel, askToFix],
  );
  React.useEffect(() => {
    if (!controller || !input.active) return;
    const producer: CodeIntelligencePaneProducer = {
      controller,
      path: input.filePath,
      machineName: input.machineName,
      machineUnreachable: input.machineUnreachable,
      openReference,
      openProblem,
      ask: askModel,
    };
    return publishCodeIntelligencePaneProducer(input.scopeId, producer);
  }, [
    askModel,
    controller,
    input.active,
    input.filePath,
    input.machineName,
    input.machineUnreachable,
    input.scopeId,
    openProblem,
    openReference,
  ]);

  // ⌘P / @ from this page lists this document's symbols (the Search owner's existing holder input).
  const symbols = React.useMemo<WorkspaceSymbolSearchInput | null>(() => {
    if (!input.scope || !input.accountId || !input.enabled || !controller)
      return null;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) return null;
    const owner = controller;
    return {
      target: {
        kind: 'workspaceFile',
        scope: input.scope,
        path: input.filePath,
        workspaceRefId,
        sessionId: workspaceRefId ? null : input.sessionId,
        serverId: input.scope.serverId,
        accountId: input.accountId,
      },
      resolverKey: `${input.scopeId}:${input.filePath}`,
      getText: () => latest.current.liveValue.get(),
      flushPendingChange: async () => {
        await latest.current.editorHandleRef.current?.flushPendingChange();
      },
      getServerOutline: (signal) => owner.outline(signal),
      isCurrent: () => latestController.current === owner,
      accountLifetime: lifetime,
      language: input.language ?? 'text',
      isDark: theme.dark === true,
      unavailableHint: t('common.unavailable'),
    };
  }, [
    controller,
    input.accountId,
    input.enabled,
    input.filePath,
    input.language,
    input.scope,
    input.scopeId,
    input.sessionId,
    theme.dark,
    workspaceRefId,
  ]);
  const searchSeed = React.useMemo(
    () =>
      input.scope
        ? {
            accountId: input.accountId,
            serverId: input.scope.serverId,
            sessionId: workspaceRefId ? null : input.sessionId,
            machineId: input.scope.machineId,
            rootPath: input.scope.rootPath,
          }
        : undefined,
    [input.accountId, input.scope, input.sessionId, workspaceRefId],
  );
  useKeyboardShortcutHandlers(
    React.useMemo(
      () =>
        input.active && searchRuntime && searchSeed
          ? {
              // Text in files and Replace start in this page's folder, like quick open below.
              'search.textInFiles': () => {
                searchRuntime.open(undefined, searchSeed, { source: 'fileContent' });
                return 'handled' as const;
              },
              'search.replaceInFiles': () => {
                searchRuntime.open(undefined, searchSeed, { source: 'fileContent', replace: true });
                return 'handled' as const;
              },
              ...(symbols ? {
              'search.symbols': () => {
                searchRuntime.open(undefined, searchSeed, {
                  source: 'symbols',
                  symbols,
                });
                return 'handled' as const;
              },
              'search.files': () => {
                searchRuntime.open(undefined, searchSeed, {
                  source: 'files',
                  symbols,
                });
                return 'handled' as const;
              },
              } : {}),
            }
          : {},
      [input.active, searchRuntime, searchSeed, symbols],
    ),
  );

  const menuCommands = React.useMemo(
    () =>
      controller
        ? {
            'code.goToDefinition': () => {
              runCursor(controller, input.editorHandleRef, 'definition');
            },
            'code.showInfo': () => {
              const anchor = runCursor(
                controller,
                input.editorHandleRef,
                'hover',
              );
              if (anchor !== undefined)
                interaction.open({ anchor, via: 'command', references: false });
            },
            'code.restart': restart,
            'code.showProblems': () => {
              showProblems();
              void controller.checkProblems();
            },
          }
        : undefined,
    [controller, input.editorHandleRef, interaction, restart, showProblems],
  );

  const layer = controller ? (
    <FileCodeIntelligenceCardLayer
      controller={controller}
      interaction={interaction}
      machineName={input.machineName}
      machineUnreachable={input.machineUnreachable}
      filePath={input.filePath}
      scopeId={input.scopeId}
      onOpenReference={openReference}
    />
  ) : null;

  return {
    controller,
    bindEditor,
    viewBinding,
    headerFacts,
    notice,
    layer,
    menuCommands,
    symbols,
    showProblems,
  };
}

/** F12 / Info at the editor's caret; returns the anchor for a card, or undefined when there is no caret. */
function runCursor(
  controller: CodeIntelligenceController,
  editorHandleRef: React.RefObject<TextEditorHandle | null>,
  kind: 'definition' | 'hover',
): Rect | null | undefined {
  const editor = editorHandleRef.current;
  const cursor = editor?.getCursorPosition?.();
  const position = cursor
    ? { line: cursor.line - 1, character: cursor.character }
    : controller.getSnapshot().selection?.position;
  if (!position) return undefined;
  void controller[kind](position);
  return editor?.getLineRect?.(position.line + 1) ?? null;
}

const EMPTY_NAMES: readonly CodeIdentifier[] = [];

/** The card leaf: the only component that follows the pointer's answers. */
function FileCodeIntelligenceCardLayer(
  props: Readonly<{
    controller: CodeIntelligenceController;
    interaction: CardInteraction;
    machineName: string;
    machineUnreachable: boolean;
    filePath: string;
    scopeId: string;
    onOpenReference: (row: CodeReferenceRow) => void;
  }>,
) {
  const { controller, interaction } = props;
  const state = React.useSyncExternalStore(
    interaction.subscribe,
    interaction.getState,
    () => null,
  );
  const snapshot = useCodeIntelligenceSnapshot(state ? controller : null);
  const query = snapshot.querySelection ?? snapshot.selection;
  const model = React.useMemo<CodeIntelligenceCardModel>(() => {
    const hover =
      snapshot.kind === 'hover' ? readCodeHoverContent(snapshot.result) : null;
    const position = query?.position;
    const diagnostics = selectCodeDiagnostics(
      controller.getDiagnosticsProjection(),
      props.filePath,
    ).items;
    const diagnostic = position
      ? (diagnostics.find(
          (item) =>
            (item.range.start.line < position.line ||
              (item.range.start.line === position.line &&
                item.range.start.character <= position.character)) &&
            (item.range.end.line > position.line ||
              (item.range.end.line === position.line &&
                item.range.end.character >= position.character)),
        ) ?? null)
      : null;
    const outside =
      snapshot.kind === 'definition' &&
      snapshot.result &&
      'locations' in snapshot.result
        ? (snapshot.result.locations.find(
            (location) =>
              'outsideWorkspace' in location && location.outsideWorkspace,
          )?.path ?? null)
        : null;
    const progress = resolveLanguageStateNote({
      snapshot,
      machineName: props.machineName,
      machineUnreachable: props.machineUnreachable,
    });
    const server = readLanguageServerLabel(snapshot.servers);
    const references =
      state?.references && snapshot.kind === 'references'
        ? {
            rows:
              snapshot.result && 'locations' in snapshot.result
                ? snapshot.result.locations.map((location) => ({
                    path: location.path,
                    line: location.range.start.line,
                    startCharacter: location.range.start.character,
                    endCharacter:
                      location.range.end.line === location.range.start.line
                        ? location.range.end.character
                        : location.range.start.character,
                    lineText: 'lineText' in location ? location.lineText : '',
                  }))
                : [],
            textMatches: snapshot.mode === 'fallback',
            partial: Boolean(
              snapshot.result &&
              'coverage' in snapshot.result &&
              snapshot.result.coverage === 'partial',
            ),
            searching:
              snapshot.status === 'searching' || snapshot.status === 'loading',
          }
        : null;
    return {
      name: query?.identifier ?? null,
      names: query?.names ?? EMPTY_NAMES,
      hover,
      diagnostic,
      outsidePath: outside,
      progress: progress?.kind === 'progress' ? progress : null,
      searching: snapshot.status === 'searching',
      sourceLabel:
        snapshot.mode === 'server' && server
          ? `${server} · ${props.machineName}`
          : null,
      references,
    };
  }, [
    controller,
    props.filePath,
    props.machineName,
    props.machineUnreachable,
    query,
    snapshot,
    state?.references,
  ]);
  // A hover with nothing to say stays closed; a tap, a command or a phone sheet always answers.
  const quietHover =
    state?.via === 'hover' &&
    !model.hover &&
    !model.diagnostic &&
    !model.progress &&
    !model.outsidePath;
  const open =
    state !== null &&
    !quietHover &&
    (state.via !== 'hover' ||
      snapshot.status !== 'searching' ||
      Boolean(model.hover));
  const close = React.useCallback(() => {
    interaction.close();
    controller.dismiss();
  }, [controller, interaction]);
  const position = query?.position ?? null;
  if (state?.problems) {
    return (
      <CodeProblemsSheet scopeId={props.scopeId} onRequestClose={close} />
    );
  }
  return (
    <CodeIntelligenceCard
      open={open}
      anchor={state?.anchor ?? query?.anchor ?? null}
      model={model}
      onRequestClose={close}
      onHoverChange={interaction.setCardHovered}
      onDefinition={() => {
        if (position) {
          interaction.close();
          void controller.definition(position);
        }
      }}
      onReferences={() => {
        if (position) void controller.references(position);
      }}
      onCopyName={() => {
        if (model.name) void setClipboardStringSafe(model.name.symbol);
      }}
      onCopyPath={(path) => {
        void setClipboardStringSafe(path);
      }}
      onChooseName={(name) => {
        if (!position) return;
        const next = { line: position.line, character: name.startCharacter };
        controller.inspect(next);
        void controller.hover(next);
      }}
      onOpenReference={(row) => {
        interaction.close();
        props.onOpenReference(row);
      }}
    />
  );
}
