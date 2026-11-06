# Changelog

## 0.1.6

- Allow reverse-proxy and public origins through the new `allowedOrigins`
  config. The listener's local origin is always allowed; Tailscale Serve,
  a public domain, or any reverse proxy origin must be listed explicitly.
- Keep the CSRF token stable across plugin hot reloads so an already-open page
  does not become unauthorized after a recomposition.
- Restrict the bootstrap `/token` route to same-origin/allowlisted callers.
- Add `node:test` coverage for origin normalization and matching.
