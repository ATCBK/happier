import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  McpImportMovedSecretV1Schema,
  type McpImportPreviewV1,
  type McpImportValuesV1,
} from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CapabilityAddFooter } from '@/components/capabilities/add/CapabilityAddModal';
import {
  useDraftReachRules,
  WhereItsOnControl,
} from '@/components/capabilities/where/WhereItsOnControl';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueRefRowsEditor } from '@/components/ui/forms/valueRefs/ValueRefRowsEditor';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  projectReachOnMachines,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { t } from '@/text';

import { McpServerMark } from '../identity/McpServerMark';
import {
  buildMcpPasteValues,
  buildMcpPastePreviewModel,
  countOpenMcpPasteValues,
  EMPTY_MCP_PASTE_ANSWERS,
  seedMcpPasteRow,
  withMcpPasteServerTransport,
  type McpPasteAnswers,
  type McpPasteAsk,
  type McpPastePreviewModel,
  type McpPasteServerModel,
} from './mcpAddPaste';
import type { McpAddPlaces } from './useMcpAddPlaces';

type Execution = ReturnType<typeof useMountedActionExecution>;

const NO_PROJECTS: readonly Readonly<{
  projectKey: string;
  name: string;
  machineCount: number;
}>[] = [];

/** A config-document link is read by the host; everything else is the pasted text itself. */
function importSource(text: string) {
  const trimmed = text.trim();
  if (/^https:\/\/\S+$/u.test(trimmed) && !trimmed.includes('install='))
    return { kind: 'link' as const, url: trimmed };
  return { kind: 'paste' as const, text };
}

/** Paste a config (lab ma-V): what it would add, with each key moved into a Saved Secret and each missing value asked. */
export function McpPasteInput(
  props: Readonly<{
    testID: string;
    initialText?: string;
    execution: Execution;
    scope: AccountSettingsScope | null;
    places: McpAddPlaces;
    writable: boolean;
    reloadCatalog: () => Promise<void>;
    onAdded: (serverIds: readonly string[]) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { execute, approval } = props.execution;
  const [text, setText] = React.useState(props.initialText ?? '');
  const [preview, setPreview] = React.useState<McpImportPreviewV1 | null>(null);
  const [answers, setAnswers] = React.useState<McpPasteAnswers>(
    EMPTY_MCP_PASTE_ANSWERS,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const retained = React.useRef<McpImportValuesV1>({});
  const draftReach = useDraftReachRules('mcp_server');
  const catalog = useSavedSecretCatalog(
    props.scope ? { scope: props.scope } : undefined,
  );
  const secrets = React.useMemo(
    () => [...catalog.materializedSecrets],
    [catalog.materializedSecrets],
  );

  // The preview follows a pause in typing: a dry run reads nothing from the machines and writes nothing.
  React.useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void execute('mcp.servers.import', {
        dryRun: true,
        source: importSource(text),
      }).then((result) => {
        if (!live) return;
        const parsed = result.ok
          ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.import'].safeParse(
              result.result,
            )
          : null;
        setPreview(
          parsed?.success && 'servers' in parsed.data ? parsed.data : null,
        );
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [execute, text]);

  const model = React.useMemo(
    () => (preview ? buildMcpPastePreviewModel(preview) : null),
    [preview],
  );
  const open = model ? countOpenMcpPasteValues(model, answers) : 0;
  const servers = model?.servers ?? [];
  const projection = React.useMemo(
    () =>
      projectReachOnMachines(
        draftReach.rules,
        props.places.machines as readonly ReachMachine[],
      ),
    [draftReach.rules, props.places.machines],
  );

  const setRow = React.useCallback(
    (inputId: string, value: ValueRefV1) =>
      setAnswers((previous) => ({
        ...previous,
        rows: { ...previous.rows, [inputId]: value },
      })),
    [],
  );
  const setField = React.useCallback(
    (inputId: string, value: string) =>
      setAnswers((previous) => ({
        ...previous,
        fields: { ...previous.fields, [inputId]: value },
      })),
    [],
  );
  const flipTransport = React.useCallback(
    (name: string, transport: 'http' | 'sse') => {
      const next = withMcpPasteServerTransport(text, name, transport);
      if (next !== null) setText(next);
    },
    [text],
  );

  const disabledReason = !props.writable
    ? t('capabilities.mcpAdd.paste.addFailed')
    : servers.length === 0
      ? null
      : open > 0
        ? t('capabilities.mcpAdd.paste.stillNeeded', { count: open })
        : null;

  const add = React.useCallback(async () => {
    if (!model || servers.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const values = buildMcpPasteValues(model, answers, retained.current);
      const result = await execute('mcp.servers.import', {
        dryRun: false,
        source: importSource(text),
        values,
        ...(draftReach.where ? { where: draftReach.where } : {}),
      });
      if (!result.ok) {
        // Keys saved before the failure are reused by the retry: never saved twice.
        const moved = Array.isArray(
          (result.details as { movedSecrets?: unknown } | undefined)
            ?.movedSecrets,
        )
          ? (result.details as { movedSecrets: unknown[] }).movedSecrets
          : [];
        for (const entry of moved) {
          const parsed = McpImportMovedSecretV1Schema.safeParse(entry);
          if (parsed.success)
            retained.current = {
              ...retained.current,
              [parsed.data.inputId]: {
                t: 'savedSecret',
                secretId: parsed.data.secretRef,
              },
            };
        }
        setError(result.errorCode ?? t('capabilities.mcpAdd.paste.addFailed'));
        return;
      }
      const committed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[
        'mcp.servers.import'
      ].safeParse(result.result);
      if (
        !committed.success ||
        !('ok' in committed.data) ||
        !committed.data.ok
      ) {
        setError(t('capabilities.mcpAdd.paste.addFailed'));
        return;
      }
      void catalog.reload().catch(() => undefined);
      await props.reloadCatalog().catch(() => undefined);
      props.onAdded(committed.data.serverIds);
    } catch (failure) {
      if (!isTeamActionApprovalPendingError(failure))
        setError(
          failure instanceof Error && failure.message
            ? failure.message
            : t('capabilities.mcpAdd.paste.addFailed'),
        );
    } finally {
      setBusy(false);
    }
  }, [
    answers,
    busy,
    catalog,
    draftReach.where,
    execute,
    model,
    props,
    servers.length,
    text,
  ]);

  const jsonPasted = /^\s*\{/u.test(text);
  const hasContent = text.trim().length > 0;
  const unreadable = preview?.errors.find((code) => !code.includes(':')) ?? null;

  return (
    <View style={styles.fill}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.paste}>
          <FieldTextInput
            testID={`${props.testID}.input`}
            value={text}
            onChangeText={setText}
            accessibilityLabel={t('capabilities.mcpAdd.paste.label')}
            placeholder={t('capabilities.mcpAdd.paste.placeholder')}
            multiline
            minLines={9}
            monospace
          />
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.mcpAdd.paste.reads')}
          </Text>
        </View>

        {approval.approvalId && props.scope ? (
          <ItemGroup>
            <ActionApprovalPendingNotice
              testID={`${props.testID}.approval`}
              message={t('secrets.catalog.approvalPending')}
              onOpenApproval={() =>
                router.pushRetainingCurrent(
                  `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.scope!.serverId)}`,
                )
              }
            />
          </ItemGroup>
        ) : null}

        {!hasContent ? (
          <Text variant="body" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.mcpAdd.paste.empty')}
          </Text>
        ) : null}
        {unreadable !== null ? (
          <Text
            variant="meta"
            style={{ color: theme.colors.status.error }}
            testID={`${props.testID}.unreadable`}
          >
            {unreadable === 'no-mcp-servers'
              ? t('capabilities.mcpAdd.paste.noServers')
              : t('capabilities.mcpAdd.paste.unreadable')}
          </Text>
        ) : null}

        {model && (servers.length > 0 || model.duplicates.length > 0) ? (
          <ItemGroup
            title={t('capabilities.mcpAdd.paste.found', {
              count: servers.length + model.duplicates.length,
            })}
            description={t('capabilities.mcpAdd.paste.foundBody')}
            surface="none"
          >
            <View style={styles.servers}>
              {servers.map((server) => (
                <PasteServer
                  key={server.name}
                  server={server}
                  answers={answers}
                  secrets={secrets}
                  scope={props.scope}
                  canFlip={jsonPasted}
                  onRow={setRow}
                  onFlip={flipTransport}
                  testID={`${props.testID}.server.${server.name}`}
                />
              ))}
              {model.duplicates.map((duplicate) => (
                <View
                  key={`duplicate:${duplicate.name}`}
                  style={styles.skipped}
                >
                  <Icon
                    name="info"
                    size={ICON_SIZE.sm}
                    color={theme.colors.text.secondary}
                  />
                  <Text
                    variant="meta"
                    style={{
                      color: theme.colors.text.secondary,
                      flexShrink: 1,
                    }}
                  >
                    {duplicate.inCatalog
                      ? t('capabilities.mcpAdd.paste.skipped', {
                          name: duplicate.name,
                        })
                      : t('capabilities.mcpAdd.paste.skippedPaste', {
                          name: duplicate.name,
                        })}
                  </Text>
                </View>
              ))}
            </View>
          </ItemGroup>
        ) : null}

        {model && model.fields.length > 0 ? (
          <ItemGroup
            title={t('capabilities.mcpAdd.paste.otherValues')}
            surface="none"
          >
            <View style={styles.servers}>
              {model.fields.map((ask) => (
                <View key={ask.inputId} style={styles.field}>
                  <Text variant="label" style={{ color: theme.colors.text.primary }}>{ask.key}</Text>
                  {ask.description ? (
                    <Text
                      variant="meta"
                      style={{ color: theme.colors.text.secondary }}
                    >
                      {ask.description}
                    </Text>
                  ) : null}
                  <FieldTextInput
                    testID={`${props.testID}.field.${ask.inputId}`}
                    value={answers.fields[ask.inputId] ?? ''}
                    onChangeText={(next) => setField(ask.inputId, next)}
                    accessibilityLabel={ask.key}
                    secureTextEntry={ask.secret}
                    invalid={
                      (answers.fields[ask.inputId] ?? '').trim().length === 0
                    }
                    monospace
                  />
                </View>
              ))}
            </View>
          </ItemGroup>
        ) : null}

        {model && model.warnings.length > 0 ? (
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {`${t('capabilities.mcpAdd.paste.warnings')} · ${model.warnings.join(' · ')}`}
          </Text>
        ) : null}

        {servers.length > 0 ? (
          <WhereItsOnControl
            testID={`${props.testID}.where`}
            kind="mcp_server"
            presentation="pick"
            rules={draftReach.rules}
            status="ready"
            projection={projection}
            places={{
              agentIds: props.places.agentIds,
              machines: props.places.placeMachines,
              projects: NO_PROJECTS,
            }}
            agentTakes={props.places.agentTakes}
            onChange={draftReach.onChange}
          />
        ) : null}
      </ScrollView>

      <CapabilityAddFooter
        start={
          error !== null ? (
            <Text
              variant="meta"
              style={{ color: theme.colors.status.error }}
              testID={`${props.testID}.error`}
            >
              {error}
            </Text>
          ) : (
            <View style={styles.note}>
              <Icon
                name="lock"
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
              />
              <Text
                variant="meta"
                style={{ color: theme.colors.text.secondary, flexShrink: 1 }}
              >
                {t('capabilities.mcpAdd.paste.footNote')}
              </Text>
            </View>
          )
        }
      >
        <RoundButton
          title={t('capabilities.mcpAdd.paste.addN', {
            count: Math.max(servers.length, 1),
          })}
          size="normal"
          loading={busy}
          disabled={
            servers.length === 0 ||
            disabledReason !== null ||
            Boolean(approval.approvalId)
          }
          {...(disabledReason ? { accessibilityHint: disabledReason } : {})}
          onPress={() => void add()}
          testID={`${props.testID}.add`}
        />
      </CapabilityAddFooter>
    </View>
  );
}

/** One server in the preview: its name and how it runs, the pasted key's fate, and each value still asked. */
function PasteServer(
  props: Readonly<{
    server: McpPasteServerModel;
    answers: McpPasteAnswers;
    secrets: SavedSecret[];
    scope: AccountSettingsScope | null;
    canFlip: boolean;
    onRow: (inputId: string, value: ValueRefV1) => void;
    onFlip: (name: string, transport: 'http' | 'sse') => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { server } = props;
  const remote = server.transport !== 'stdio';
  const rows = (asks: readonly McpPasteAsk[]) =>
    Object.fromEntries(
      asks.map((ask): [string, ValueRefV1] => [
        ask.key,
        props.answers.rows[ask.inputId] ?? seedMcpPasteRow(ask),
      ]),
    );
  const change =
    (asks: readonly McpPasteAsk[]) => (next: Record<string, ValueRefV1>) => {
      for (const ask of asks) {
        const value = next[ask.key];
        if (value && value !== props.answers.rows[ask.inputId])
          props.onRow(ask.inputId, value);
      }
    };
  const attention = (asks: readonly McpPasteAsk[]) =>
    new Set(
      asks
        .filter((ask) => {
          const value = props.answers.rows[ask.inputId] ?? seedMcpPasteRow(ask);
          return value.t === 'literal'
            ? value.v.trim().length === 0
            : value.t === 'savedSecret' && value.secretId.length === 0;
        })
        .map((ask) => ask.key),
    );
  return (
    <View style={styles.server} testID={props.testID}>
      <View style={styles.serverHead}>
        <McpServerMark transport={server.transport} size={20} />
        <Text variant="body" style={styles.mono} numberOfLines={1}>
          {server.name}
        </Text>
        <Text variant="meta" style={{ color: theme.colors.text.tertiary }}>
          {remote
            ? t('capabilities.mcpAdd.paste.remote')
            : t('capabilities.mcpAdd.paste.local')}
        </Text>
      </View>
      {remote ? (
        <View style={styles.transport}>
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.mcpAdd.paste.transport')}
          </Text>
          {props.canFlip ? (
            <SegmentedTabBar
              tabs={[
                {
                  id: 'http',
                  label: t('capabilities.mcpAdd.paste.http'),
                  testID: `${props.testID}.transport.http`,
                },
                {
                  id: 'sse',
                  label: t('capabilities.mcpAdd.paste.sse'),
                  testID: `${props.testID}.transport.sse`,
                },
              ]}
              activeTabId={server.transport}
              onSelectTab={(id) =>
                props.onFlip(server.name, id as 'http' | 'sse')
              }
              segmentSizing="content"
              accessibilityLabel={t('capabilities.mcpAdd.paste.transport')}
            />
          ) : (
            <Text variant="meta" style={{ color: theme.colors.text.primary }}>
              {server.transport === 'sse'
                ? t('capabilities.mcpAdd.paste.sse')
                : t('capabilities.mcpAdd.paste.http')}
            </Text>
          )}
        </View>
      ) : null}
      {server.literalSecrets.map((secret) => (
        <View key={secret.inputId} style={styles.note}>
          <Icon
            name="lock"
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
          <Text
            variant="meta"
            style={{ color: theme.colors.text.secondary, flexShrink: 1 }}
          >
            {t('capabilities.mcpAdd.paste.keySaved', {
              key: secret.key,
              name: secret.secretName,
            })}
          </Text>
        </View>
      ))}
      {server.env.length > 0 ? (
        <ValueRefRowsEditor
          kind="env"
          declaredNames
          entries={rows(server.env)}
          onChangeEntries={change(server.env)}
          secrets={props.secrets}
          scope={props.scope}
          testIdPrefix={`${props.testID}.env`}
          attentionKeys={attention(server.env)}
        />
      ) : null}
      {server.headers.length > 0 ? (
        <ValueRefRowsEditor
          kind="header"
          declaredNames
          entries={rows(server.headers)}
          onChangeEntries={change(server.headers)}
          secrets={props.secrets}
          scope={props.scope}
          testIdPrefix={`${props.testID}.header`}
          attentionKeys={attention(server.headers)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  body: {
    paddingHorizontal: theme.space.s24,
    paddingBottom: theme.space.s24,
    gap: theme.space.s24,
  },
  paste: { gap: theme.space.s8 },
  servers: { gap: theme.space.s16 },
  server: { gap: theme.space.s8 },
  serverHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    flexWrap: 'wrap',
  },
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  skipped: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  field: { gap: theme.space.s4 },
  mono: { ...Typography.mono(), flexShrink: 1, color: theme.colors.text.primary },
}));
