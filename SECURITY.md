# Security policy

## Supported versions

Only the latest published minor version receives security fixes while DeepSeek
Harness is in developer preview.

## Deployment requirements

- Keep the plugin bound to `127.0.0.1` and terminate TLS at a reverse proxy.
- Set `SLASHX_GATEWAY_TOKEN` to at least 32 random characters. Never put it in a
  URL, browser bundle, log, or repository.
- Do not expose the native Harness `/api` routes. Expose only the gateway
  prefix required by SlashX.
- Keep private media hosts blocked. Add a host to
  `SLASHX_GATEWAY_PRIVATE_MEDIA_HOSTS` only when it is an exact, trusted media
  origin operated by you.
- Mount `SLASHX_GATEWAY_STATE_ROOT` on a protected persistent volume. The
  directory can contain user uploads, generated artifacts, and conversation
  workspaces.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
private vulnerability reporting form on the Security tab and include the
affected version, deployment topology, impact, and a minimal reproduction. Do
not include live tokens or user files.
