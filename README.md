# dsh-plugin-mcp-toggles

Per-session MCP visibility for DeepSeek Harness, with a **user-only switch**.

Fork of [ZhaoHanshao/dsh-plugin-mcp-toggles](https://github.com/ZhaoHanshao/dsh-plugin-mcp-toggles),
maintained at [ZEN-GUO/dsh-plugin-mcp-toggles](https://github.com/ZEN-GUO/dsh-plugin-mcp-toggles).

## Behavior

- **Every MCP is listed** — profile-level MCPs and project-level MCPs.
- **Every MCP is off at the start of a session.** New sessions start empty; there
  is no persistent enablement or trust store.
- **Only the user can enable/disable an MCP**, from the MCP panel in the
  conversation header.
- **The agent has no enable/disable tool.** It may call the read-only
  `mcp_list` tool and must ask the user to open a disabled MCP.
- **Global MCPs are unlabelled** (they are the default MCPs).
- **Project MCPs are labelled `Project MCP`**, with their source file.
- Turning an MCP off never lets the agent turn it back on; the UI is the only
  switch.

Global MCP rows stay connected at the profile level and are hidden with an
agent-scoped `tools.restrict()` mask. Project MCPs are mounted into the current
agent only after the user enables them, and are disposed when disabled.

## Project MCP sources

The plugin reads these files under the session's working directory:

| File | Default ownership |
|---|---|
| `.dsh/mcp.json`, `.dsh/mcp.yaml` | DSH |
| `.mcp.json`, `mcp.json` | universal |
| `.vscode/mcp.json` | VS Code |
| `.pi/mcp.json` | Pi |
| `.claude/mcp.json` | Claude |
| `.cursor/mcp.json` | Cursor |
| `opencode.json` (`mcp`) | OpenCode |
| `.codex/config.toml` (`mcp_servers`) | Codex |

Supported shapes include `mcpServers`, `servers`, `mcp`, and `mcp_servers`, in
JSON/JSONC/YAML/TOML. Listing is read-only: no command is spawned and no
environment reference is resolved until the user enables the server.

Entries explicitly targeting another harness are skipped. Universal files with
no target metadata are treated as usable by DSH. By default, unmarked entries are listed even inside `.pi`, `.vscode`, or
`.codex`; entries explicitly targeting another harness are skipped. Set
`respectDirectoryOwnership: true` to also skip unmarked entries in harness-owned
directories.

## Configuration

```yaml
- id: mcp-toggles
  name: dsh-plugin-mcp-toggles
  config:
    sharedResourceTools: true
    respectDirectoryOwnership: true
    allowedOrigins:
      - https://dsh.zenguo.me
      - https://zen-omen15-linux.tail785d47.ts.net:8443
```

| Field | Default | Meaning |
|---|---|---|
| `sharedResourceTools` | `true` | Hide shared MCP resource tools while every MCP is off. |
| `extraServers` | `[]` | Extra names to list even when no tool is currently registered. |
| `respectDirectoryOwnership` | `false` | When `true`, treat `.pi`, `.vscode`, `.codex`, etc. as owned by that harness. The default lists unmarked entries and only excludes explicit other-harness targets. |
| `allowedOrigins` | `[]` | Additional browser origins allowed to call the MCP panel API. The local listener origin is always allowed. |

`webServer.getOrigin()` is the local listener origin, not `--public-url`. Remote
access through Tailscale Serve or a public domain must list that exact origin in
`allowedOrigins`.

## Agent experience

The agent sees only the MCP tools currently enabled by the user. `mcp_list`
returns names, source (`default` or `project`), enabled state, connection state,
and tool counts. It does not expose command arguments or environment values.
When a needed MCP is disabled, the agent asks the user to enable it in the MCP
panel.

## Install

```bash
dsh plugin --profile web add github:ZEN-GUO/dsh-plugin-mcp-toggles#v0.2.0
```

Restart DSH and hard-refresh the browser once after installing a new client
bundle.

## Tests

```bash
npm install
npm test
```

MIT. Original copyright ZhaoHanshao; fork changes by ZEN-GUO.
