import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';
import { describeUnnamedApprovalSession } from './approvalRequesterLabels';
import { describeApprovalActionFields } from './approvalFieldValues';
import { builtInSettingUiDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { t } from '@/text';

const initialState = storage.getState();
const profiles: string[] = [];

afterEach(async () => {
    await standardCleanup();
    storage.setState(initialState);
    for (const id of profiles.splice(0)) await removeServerProfile(id);
});

it('reads the declared setting name and exact new value in both approval anatomies', async () => {
    const anchor = 'delegation.workDepthLimit';
    const presentation = describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor, value: 3 } });
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} />);
        const text = screen.getTextContent();
        expect(text).toContain(t(builtInSettingUiDeclaration(anchor).titleKey));
        expect(text).toContain('3');
        expect(text).not.toContain(anchor);
        const details = screen.findAllByTestId('approvals.technical-details')
            .find(node => typeof node.props.onExpandedChange === 'function');
        await act(async () => { details?.props.onExpandedChange(true); });
        expect(screen.getTextContent()).toContain(anchor);
    }
});

it('the approval Details page preserves an exact remote host id when a session has the same id', async () => {
    const profile = await upsertServerProfile({ name: 'Approval Home', serverUrl: 'https://approval-reference.test' });
    profiles.push(profile.id);
    const otherHome = await upsertServerProfile({ name: 'Unrelated Home', serverUrl: 'https://unrelated-approval-reference.test' });
    profiles.push(otherHome.id);
    const hostId = 'exact-remote-host';
    const session = createSessionFixture();
    if (!session.metadata) throw new Error('Missing Session metadata fixture');
    await act(async () => {
        storage.getState().applySessions([
            createSessionFixture({ id: hostId, serverId: profile.id,
                metadata: { ...session.metadata, name: 'Unrelated same-id session' } }),
            createSessionFixture({ id: profile.id, serverId: profile.id,
                metadata: { ...session.metadata, name: 'Session sharing Home token' } }),
        ]);
    });
    const presentation = { rows: [
        { kind: 'value', path: 'hostId', title: 'Remote host', value: hostId },
        { kind: 'value', path: 'operation.kind', title: 'Operation', value: 'disable' },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    const details = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy="page" serverId={profile.id} />);
    expect(details.getTextContent()).toContain(hostId);
    expect(details.getTextContent()).not.toContain('Unrelated same-id session');

    // Save/duplicate and relay Address admit any nonempty literal host identity,
    // including text that happens to resemble a structured Session reference.
    const structuredLookingHostId = JSON.stringify({ kind: 'host', id: hostId });
    const structuredLookingHost = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={profile.id} presentation={{
        rows: [{ kind: 'value', path: 'hostId', title: 'Remote host', value: structuredLookingHostId }],
        unrepresentable: null,
    }} />);
    expect(structuredLookingHost.getTextContent()).toContain(structuredLookingHostId);
    expect(structuredLookingHost.getTextContent()).not.toContain('Unrelated same-id session');

    // The renderer consumes Protocol's typed reference projection, not path/value guesses.
    // describeApprovalReference emits these shapes for declared Session and serverId fields.
    const references = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={profile.id} presentation={{
        rows: [
            { kind: 'value', path: 'sessionId', title: 'Session', value: hostId,
                reference: { kind: 'session', id: hostId } },
            { kind: 'value', path: 'serverId', title: 'Home', value: profile.id,
                reference: { kind: 'home', id: profile.id } },
            { kind: 'value', path: 'parentSessionId', title: 'Unavailable session', value: otherHome.id,
                reference: { kind: 'session', id: otherHome.id } },
        ], unrepresentable: null,
    }} />);
    expect(references.getTextContent()).toContain('Unrelated same-id session');
    expect(references.getTextContent()).toContain('Approval Home');
    expect(references.getTextContent()).not.toContain('Session sharing Home token');
    expect(references.getTextContent()).not.toContain('Unrelated Home');
    expect(references.getTextContent()).toContain(describeUnnamedApprovalSession('Approval Home'));
});

it('reads a structured value as labelled entries rather than raw JSON, in both anatomies', async () => {
    const literal = JSON.stringify({ kind: 'create', board: { title: 'Launch plan' } });
    const presentation = { rows: [{
        kind: 'value', path: 'intent', title: 'Board intent', value: literal,
        entries: [
            { label: 'Kind', value: 'create', depth: 0 },
            { label: 'Board', value: null, depth: 0 },
            { label: 'Title', value: 'Launch plan', depth: 1 },
        ],
    }], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} />);
        const text = screen.getTextContent();
        expect(text).toContain('Board intent');
        expect(text).toContain('Launch plan');
        expect(text).toContain('Kind');
        expect(text).not.toContain(literal);
    }
});

it('gives a structured value the same row as its sibling arguments on the approval page', async () => {
    const { Item } = await import('@/components/ui/lists/Item');
    const presentation = { rows: [
        { kind: 'value', path: 'groupId', title: 'Group id', value: 'usage-group' },
        { kind: 'value', path: 'surface', title: 'Widget surface', value: '{"area":"main"}',
            entries: [{ label: 'Area', value: 'main', depth: 0 }] },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy="page" />);
    // Every argument reads name-over-value through the one row owner, so a structured value cannot
    // invert the hierarchy its siblings use (a small label over large values).
    const titles = screen.findAllByType(Item).map((item) => item.props.title);
    expect(titles).toEqual(['Group id', 'Widget surface']);
    expect(screen.getTextContent()).toContain('Area');
});

it('reads references by name, keeps exact ids in Technical details, and drops meaningless internals', async () => {
    const profile = await upsertServerProfile({ name: 'Approval Home', serverUrl: 'https://approval-technical.test' });
    profiles.push(profile.id);
    const accountId = '5e3a0581-6f3d-4e73-bf40-383db0be6c3e';
    await act(async () => { storage.setState({ settingsScope: { serverId: profile.id, accountId } }); });
    const presentation = { rows: [
        { kind: 'value', path: 'surface', title: 'Widget surface', value: '{}', entries: [
            { label: 'Server id', value: profile.id, depth: 0, reference: { kind: 'home', id: profile.id } },
            { label: 'Account id', value: accountId, depth: 0, reference: { kind: 'account', id: accountId } },
            { label: 'Owner', value: null, depth: 0 },
            { label: 'Page id', value: 'usage', depth: 1 },
            { label: 'V', value: '7', depth: 1, technical: true },
            { label: 'Bindings', value: '{}', depth: 1, technical: true },
        ] },
        { kind: 'value', path: 'groupId', title: 'Group id', value: 'usage-group' },
    ], unrepresentable: null } satisfies ApprovalActionFieldsPresentation;
    for (const anatomy of ['page', 'card'] as const) {
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} anatomy={anatomy} serverId={profile.id} />);
        const text = screen.getTextContent();
        expect(text).toContain('Approval Home');
        expect(text).toContain('Your account');
        // A target id stays in view: the approval shows exactly what it acts on.
        expect(text).toContain('usage-group');
        expect(text).toContain('usage');
        expect(text).not.toContain(profile.id);
        expect(text).not.toContain(accountId);
        // A key over a name names the thing, not its id: "Home · Approval Home", "Account · Your account".
        expect(text).not.toContain('Server id');
        expect(text).not.toContain('Account id');
        expect(text).toContain('Account');
        const technical = screen.findAllByTestId('approvals.technical-details')
            .find((node) => typeof node.props.onExpandedChange === 'function');
        expect(technical).toBeTruthy();
        await act(async () => { technical?.props.onExpandedChange(true); });
        const opened = screen.getTextContent();
        expect(opened).toContain(accountId);
        expect(opened).toContain(profile.id);
        expect(opened).not.toContain('Widget surface › Owner › V');
        expect(opened).not.toContain('Widget surface › Owner › Bindings');
        expect(opened).not.toContain('{}');
        // The exact id behind a name keeps its id label in Technical details.
        expect(opened).toContain('Widget surface › Server id');
    }
});

it('reads the approval\u2019s own Home and Account when the request carries the Home\u2019s portable identity', async () => {
    // An unnamed Home: the request's `serverId` is the Home's identity, this device addresses it by a profile id.
    const url = 'https://approval-identity.test';
    const created = await upsertServerProfile({ serverUrl: url });
    profiles.push(created.id);
    await setServerProfileIdentityForUrl(url, 'srv_portable_identity');
    const accountId = 'viewer-account';
    await act(async () => { storage.setState({ settingsScope: { serverId: 'srv_portable_identity', accountId } }); });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" serverId={created.id} presentation={{ rows: [
        { kind: 'value', path: 'surface', title: 'Widget surface', value: '{}', entries: [
            { label: 'Server id', value: 'srv_portable_identity', depth: 0, reference: { kind: 'home', id: 'srv_portable_identity' } },
            { label: 'Account id', value: accountId, depth: 0, reference: { kind: 'account', id: accountId } },
        ] },
    ], unrepresentable: null }} />);
    const text = screen.getTextContent();
    expect(text).not.toContain('srv_portable_identity');
    expect(text).not.toContain(accountId);
    expect(text).toContain('Your account');
});
