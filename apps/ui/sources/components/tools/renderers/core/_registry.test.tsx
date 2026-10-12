import { describe, expect, it } from 'vitest';
import {
    getToolViewComponent,
    toolViewRegistry,
    SubAgentView,
    TaskOutputView,
    TaskStopView,
} from './_registry';
import { ReadView } from '../fileOps/ReadView';
import { WorkflowActivityView } from '../workflow/WorkflowActivityView';
import { MCPToolView } from '../system/MCPToolView';
import { UnknownToolView } from '../system/UnknownToolView';

describe('toolViewRegistry', () => {
    it('registers a Read view for lowercase read tool name', () => {
        expect(getToolViewComponent('read')).toBe(ReadView);
    });

    it('maps ACP lowercase tool names to canonical renderers (search/glob/grep/ls/write/delete)', () => {
        expect(getToolViewComponent('search')).toBe(toolViewRegistry.CodeSearch);
        expect(getToolViewComponent('glob')).toBe(toolViewRegistry.Glob);
        expect(getToolViewComponent('grep')).toBe(toolViewRegistry.Grep);
        expect(getToolViewComponent('ls')).toBe(toolViewRegistry.LS);
        expect(getToolViewComponent('write')).toBe(toolViewRegistry.Write);
        expect(getToolViewComponent('delete')).toBe(toolViewRegistry.Delete);
        expect(getToolViewComponent('remove')).toBe(toolViewRegistry.Delete);
    });

    it('keeps background-task control tools off the subagent card', () => {
        for (const name of ['TaskOutput', 'task_output']) {
            expect(getToolViewComponent(name)).toBe(TaskOutputView);
            expect(getToolViewComponent(name)).not.toBe(SubAgentView);
        }
        for (const name of ['TaskStop', 'task_stop']) {
            expect(getToolViewComponent(name)).toBe(TaskStopView);
            expect(getToolViewComponent(name)).not.toBe(SubAgentView);
        }
    });

    it('maps Claude task helper tools to SubAgentView (TaskCreate/TaskList/TaskUpdate)', () => {
        expect(getToolViewComponent('TaskCreate')).toBe(SubAgentView);
        expect(getToolViewComponent('TaskList')).toBe(SubAgentView);
        expect(getToolViewComponent('TaskUpdate')).toBe(SubAgentView);
        expect(getToolViewComponent('SubAgent')).toBe(SubAgentView);
    });

    it('returns a renderer for canonical Patch tools', () => {
        expect(getToolViewComponent('Patch')).not.toBeNull();
    });

    it('maps SubAgentRun to its dedicated view', () => {
        expect(getToolViewComponent('SubAgentRun')).toBe(toolViewRegistry.SubAgentRun);
    });

    it('maps canonical Workflow to the records-backed WorkflowActivityView, distinct from the subagent view (no double render)', () => {
        expect(getToolViewComponent('Workflow')).toBe(WorkflowActivityView);
        expect(toolViewRegistry.Workflow).toBe(WorkflowActivityView);
        // The durable workflow card and the message-derived subagent summary are SEPARATE renderers:
        // a canonical `Workflow` tool must never resolve to the subagent path (would double-render).
        expect(getToolViewComponent('Workflow')).not.toBe(SubAgentView);
        expect(getToolViewComponent('Task')).toBe(SubAgentView);
        expect(getToolViewComponent('SubAgent')).toBe(SubAgentView);
    });

    it('maps Agent Team tools to a dedicated view', () => {
        expect(getToolViewComponent('AgentTeamCreate')).toBe(toolViewRegistry.AgentTeamCreate);
        expect(getToolViewComponent('AgentTeamDelete')).toBe(toolViewRegistry.AgentTeamDelete);
        expect(getToolViewComponent('AgentTeamSendMessage')).toBe(toolViewRegistry.AgentTeamSendMessage);
    });

    it('uses the MCP tool renderer for any mcp__* tool name', () => {
        expect(getToolViewComponent('mcp__linear__create_issue')).toBe(MCPToolView);
    });

    it('does not route malformed slash-delimited change title names directly to the dedicated renderer', () => {
        expect(getToolViewComponent('happier/change_title')).toBe(UnknownToolView);
    });

    it('falls back to a generic renderer for unknown tool names', () => {
        expect(getToolViewComponent('TotallyNewToolFromFutureProvider')).toBe(UnknownToolView);
    });
});
