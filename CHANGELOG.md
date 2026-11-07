# Changelog

## 0.2.0

- Every MCP (global and project-level) starts **disabled** in each new session.
- Only the user can enable/disable an MCP; the plugin registers no enable or
  disable tool for the agent.
- Add the read-only `mcp_list` tool so the agent can see which MCPs exist and
  ask the user to open a disabled one.
- Add project-level MCP discovery for `.dsh/mcp.json|yaml`, `.mcp.json`,
  `mcp.json`, VS Code, Pi, Claude, Cursor, OpenCode, and Codex shapes.
- Project MCPs are labelled; global MCPs are unlabelled. Project entries that
  explicitly belong to another harness are skipped.
- Project MCPs are mounted into the current agent only when the user enables
  them; disabling disposes the agent-scoped MCP client.
- State is memory-only: a new session starts with every MCP off.
- Keep the remote-origin allowlist, stable token, and no unauthenticated
  `/token` bootstrap from 0.1.6.

## 0.1.6

- Allow reverse-proxy/public origins through `allowedOrigins`.
- Keep the CSRF token stable across plugin hot reloads.
- Restrict bootstrap token access to same-origin/allowlisted callers.
- Add origin normalization tests.
