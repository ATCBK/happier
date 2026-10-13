// Captured 2026-10-13 from https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json.
// Envelope 1.0.0; source agent schema: https://cdn.agentclientprotocol.com/registry/v1/latest/agent.schema.json.
// Selected stable records are unmodified; the full index contained 41 agents and four .tar.bz2 targets (goose).
export const ACP_REGISTRY_V1_FIXTURE = {
  "version": "1.0.0",
  "agents": [
    {
      "id": "claude-acp",
      "name": "Claude Agent",
      "version": "0.89.1",
      "description": "ACP wrapper for Anthropic's Claude",
      "repository": "https://github.com/agentclientprotocol/claude-agent-acp",
      "authors": [
        "Anthropic",
        "Zed Industries",
        "JetBrains"
      ],
      "license": "proprietary",
      "license_url": "https://github.com/agentclientprotocol/claude-agent-acp/blob/main/LICENSE",
      "distribution": {
        "npx": {
          "package": "@agentclientprotocol/claude-agent-acp@0.89.1"
        }
      },
      "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg"
    },
    {
      "id": "fast-agent",
      "name": "fast-agent",
      "version": "0.10.1",
      "description": "Code and build agents with comprehensive multi-provider support",
      "repository": "https://github.com/evalstate/fast-agent",
      "website": "https://fast-agent.ai",
      "authors": [
        "enquiries@fast-agent.ai"
      ],
      "license": "Apache 2.0",
      "license_url": "https://github.com/evalstate/fast-agent/blob/main/LICENSE",
      "distribution": {
        "uvx": {
          "package": "fast-agent-acp==0.10.1",
          "args": [
            "-x"
          ],
          "env": {
            "FAST_AGENT_MODEL": "codexplan"
          }
        }
      },
      "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/fast-agent.svg"
    },
    {
      "id": "goose",
      "name": "goose",
      "version": "1.54.0",
      "description": "A local, extensible, open source AI agent that automates engineering tasks",
      "repository": "https://github.com/block/goose",
      "website": "https://block.github.io/goose/",
      "authors": [
        "Block"
      ],
      "license": "Apache-2.0",
      "license_url": "https://github.com/block/goose/blob/main/LICENSE",
      "distribution": {
        "binary": {
          "darwin-aarch64": {
            "archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-aarch64-apple-darwin.tar.bz2",
            "cmd": "./goose",
            "args": [
              "acp"
            ],
            "sha256": "63738f0eed2fe9d8585a4ba988c3ffb23d600db0b43858a6cd868fa6b035a7af"
          },
          "darwin-x86_64": {
            "archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-x86_64-apple-darwin.tar.bz2",
            "cmd": "./goose",
            "args": [
              "acp"
            ],
            "sha256": "81fd55f4003950bb72719402e2defb1375eef4b9a739d901a365fb737b73aeee"
          },
          "linux-aarch64": {
            "archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-aarch64-unknown-linux-gnu.tar.bz2",
            "cmd": "./goose",
            "args": [
              "acp"
            ],
            "sha256": "8c7ad233bdaf05f10a52ef36f3ce50f839cb1d2d1df5b31b172af7150c1c288e"
          },
          "linux-x86_64": {
            "archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-x86_64-unknown-linux-gnu.tar.bz2",
            "cmd": "./goose",
            "args": [
              "acp"
            ],
            "sha256": "bf01cb6359f7a2b1acb54ca4827e1d059b18aabb3d2b75202e21066cfd3a3396"
          },
          "windows-x86_64": {
            "archive": "https://github.com/block/goose/releases/download/v1.54.0/goose-x86_64-pc-windows-msvc.zip",
            "cmd": "./goose-package\\goose.exe",
            "args": [
              "acp"
            ],
            "sha256": "5c39bc91c3eadc231847e21a8a469e778431084437b233a63a950fee22db6239"
          }
        }
      },
      "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/goose.svg"
    },
    {
      "id": "junie",
      "name": "Junie",
      "version": "3579.7.0",
      "description": "AI Coding Agent by JetBrains",
      "repository": "https://github.com/JetBrains/junie-acp-release",
      "website": "https://junie.jetbrains.com",
      "authors": [
        "JetBrains"
      ],
      "license": "proprietary",
      "license_url": "https://www.jetbrains.com/legal/docs/terms/jetbrains-ai-service/",
      "distribution": {
        "binary": {
          "darwin-aarch64": {
            "archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.7/junie-release-3579.7-macos-aarch64.zip",
            "cmd": "./Applications/junie.app/Contents/MacOS/junie",
            "args": [
              "--acp=true"
            ]
          },
          "darwin-x86_64": {
            "archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.7/junie-release-3579.7-macos-amd64.zip",
            "cmd": "./Applications/junie.app/Contents/MacOS/junie",
            "args": [
              "--acp=true"
            ]
          },
          "linux-aarch64": {
            "archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.7/junie-release-3579.7-linux-aarch64.zip",
            "cmd": "./junie-app/bin/junie",
            "args": [
              "--acp=true"
            ]
          },
          "linux-x86_64": {
            "archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.7/junie-release-3579.7-linux-amd64.zip",
            "cmd": "./junie-app/bin/junie",
            "args": [
              "--acp=true"
            ]
          },
          "windows-x86_64": {
            "archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.7/junie-release-3579.7-windows-amd64.zip",
            "cmd": "./junie/junie.exe",
            "args": [
              "--acp=true"
            ]
          },
          "windows-aarch64": {
            "archive": "https://github.com/JetBrains/junie-acp-release/releases/download/3579.7/junie-release-3579.7-windows-aarch64.zip",
            "cmd": "./junie/junie.exe",
            "args": [
              "--acp=true"
            ]
          }
        }
      },
      "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/junie.svg"
    }
  ]
};

// Same CDN index capture, 2026-10-13: real per-platform binary environment defaults.
export const ACP_REGISTRY_BINARY_ENV_FIXTURE = {
  "id": "vtcode",
  "name": "VT Code",
  "version": "0.96.14",
  "description": "An open-source coding agent with LLM-native code understanding and robust shell safety. Supports multiple LLM providers with automatic failover and efficient context management.",
  "repository": "https://github.com/vinhnx/VTCode",
  "website": "https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md",
  "authors": [
    "vinhnx"
  ],
  "license": "MIT",
  "license_url": "https://github.com/vinhnx/VTCode/blob/main/LICENSE",
  "distribution": {
    "binary": {
      "darwin-aarch64": {
        "archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-aarch64-apple-darwin.tar.gz",
        "cmd": "./vtcode",
        "args": [
          "acp"
        ],
        "env": {
          "VT_ACP_ENABLED": "1",
          "VT_ACP_ZED_ENABLED": "1"
        }
      },
      "darwin-x86_64": {
        "archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-apple-darwin.tar.gz",
        "cmd": "./vtcode",
        "args": [
          "acp"
        ],
        "env": {
          "VT_ACP_ENABLED": "1",
          "VT_ACP_ZED_ENABLED": "1"
        }
      },
      "linux-x86_64": {
        "archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-unknown-linux-gnu.tar.gz",
        "cmd": "./vtcode",
        "args": [
          "acp"
        ],
        "env": {
          "VT_ACP_ENABLED": "1",
          "VT_ACP_ZED_ENABLED": "1"
        }
      },
      "windows-x86_64": {
        "archive": "https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-x86_64-pc-windows-msvc.zip",
        "cmd": "vtcode.exe",
        "args": [
          "acp"
        ],
        "env": {
          "VT_ACP_ENABLED": "1",
          "VT_ACP_ZED_ENABLED": "1"
        }
      }
    }
  },
  "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/vtcode.svg"
};
