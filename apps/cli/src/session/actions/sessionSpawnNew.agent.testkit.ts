// Exact credential-free cont6 seq13 authoring input. Connected Account ids are selectors, not credentials.
export const inheritedCodexInput = {
  "creationKey": "FIX-AGENT-AUTH-CONT6-CHILD-cmvd7yezo007vmcol3pu0sjus",
  "title": "FIX-AGENT-AUTH cont6 child",
  "directory": {
    "kind": "path",
    "path": "/tmp"
  },
  "roleId": "builder",
  "permissionMode": "default",
  "modelSelection": {
    "v": 1,
    "ref": {
      "agentTargetKey": "agent:happier.agent.codex/codex",
      "providerConnectionId": null,
      "modelId": "gpt-6.1-sol"
    },
    "updatedAt": 1792291780969
  },
  "configuration": {
    "mode": {
      "value": "default",
      "updatedAtMs": 1792291780969
    },
    "model": {
      "value": "gpt-6.1-sol",
      "updatedAtMs": 1792291780969
    },
    "permissionIntent": {
      "value": "default",
      "updatedAtMs": 1792291780969
    },
    "options": {
      "reasoning_effort": {
        "value": "low",
        "updatedAtMs": 1792291780969
      }
    }
  },
  "connectedServices": {
    "v": 2,
    "bindingsByServiceId": {
      "happier.agent.codex/openai-codex": {
        "source": "connected",
        "selection": "profile",
        "profileId": "97bd5614-8970-4068-87f2-1447de69d604"
      }
    }
  },
  "initialInput": {
    "text": "Reply exactly FIX_AGENT_AUTH_CONT6_CHILD_READY, then idle. Do not use tools, change files, delegate or start workflows."
  }
} as const;
