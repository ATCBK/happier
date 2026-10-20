import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopeActionOutputSchemas } from '@happier-dev/protocol/actions/scopeActionFamily';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { invokeScopeAction, registerShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { RightSidebarActionsContext, usePublishRightSidebarActions, type RightSidebarActions } from './rightSidebarActions';

afterEach(standardCleanup);

describe('mounted right-sidebar Action publication', () => {
  it('uses the current catalog and chooser through the column owner and withdraws on unmount', async () => {
    let selected = 'files';
    let available = ['files', 'plugin:notes'];
    const publication = { current: null as RightSidebarActions | null };
    function Rail() {
      usePublishRightSidebarActions({ tabs: available, activeTab: selected, selectTab: tab => { selected = tab; } });
      return null;
    }
    const read = () => ({ present: true, visible: false, available: publication.current !== null,
      ...publication.current, setVisible: () => {} });
    const cleanup = registerShellColumnActionOwner('side', read);
    const screen = await renderScreen(<RightSidebarActionsContext.Provider value={publication}><Rail /></RightSidebarActionsContext.Provider>);
    try {
      expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: true, tab: 'plugin:notes' })).toEqual({ ok: true });
      expect(selected).toBe('plugin:notes');
      available = ['files'];
      await act(async () => { screen.update(<RightSidebarActionsContext.Provider value={publication}><Rail /></RightSidebarActionsContext.Provider>); });
      const result = ScopeActionOutputSchemas['shell.column.get'].parse(await invokeScopeAction('shell.column.get', { column: 'side' }));
      expect(result.tabs).toEqual(['files']);
      expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: true, tab: 'plugin:notes' })).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
      await act(async () => { screen.unmount(); });
      expect(publication.current).toBeNull();
      expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: true })).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
    } finally { cleanup(); }
  });
});
