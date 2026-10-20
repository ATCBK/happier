import type {
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntimeContextV1,
    AgentRuntimeFactory,
    AgentSessionOpenRequest,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

import type {
    NormalizedPluginDeclarativeAcpRuntime,
} from '@/agent/acp/runtime/definition/plugin';

export function createHostDeclarativeAcpAgentRuntimeFactory(
    runtime: NormalizedPluginDeclarativeAcpRuntime,
    options: Readonly<{ executionRunContextV1: boolean }>,
): AgentRuntimeFactory {
    return async () => Object.freeze({
        sessions: Object.freeze({
            async open(
                request: AgentSessionOpenRequest,
                context: AgentSessionRuntimeContext,
            ) {
                return await context.protocols.acp.open(request, runtime);
            },
            ...(options.executionRunContextV1
                ? {
                    executionRunContextV1: Object.freeze({
                        async openConversation(
                            request: AgentExecutionRunOpenRequest,
                            context: AgentExecutionRunRuntimeContextV1,
                        ) {
                            if (!context.protocols.acp.openExecutionRunConversationV1) {
                                throw new PluginError({ code: 'execution_run_protocol_unsupported',
                                    message: 'This host does not support retained detached ACP conversations.' });
                            }
                            return await context.protocols.acp.openExecutionRunConversationV1(request, runtime);
                        },
                        async open(
                            request: AgentExecutionRunOpenRequest,
                            context: AgentExecutionRunRuntimeContextV1,
                        ) {
                            return await context.protocols.acp.openExecutionRunV1(request, runtime);
                        },
                    }),
                }
                : {}),
        }),
    });
}
