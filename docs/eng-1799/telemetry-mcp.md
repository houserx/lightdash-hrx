# Telemetry MCP server: attaching it and how auth works

The Telemetry MCP server (`packages/telemetry-mcp`, CONTRACTS §7) lets HouseRx engineers and their agents query the
Telemetry Sources, the Alert Rules of the Operations Project and the Platform Database over MCP. Every query runs
through the Federation Engine as the person who asked, so the engine applies that person's grants and records each
Audited Query. The server's env vars, its tool list and how to build and test it are in the package
[README](../../packages/telemetry-mcp/README.md). Terms follow the glossary in [CONTEXT.md](../../CONTEXT.md).

The examples use `https://telemetry-mcp.example.com` for the server's public base URL (`MCP_PUBLIC_URL`). The MCP
endpoint is always that URL plus `/mcp`.

## Before you attach it

- You need an Okta account in the HouseRx org that is allowed to sign in to the Okta app whose audience is
  `OKTA_AUDIENCE`.
- You need an active Lightdash user with the same email as your Okta account. Without one the server answers but
  lists no tools.
- What you can read depends on your Lightdash user attributes (see [Auth](#auth)). `platform_read` opens the
  Platform Database tools and `platform_write` opens `write_preview`. Ask a Lightdash admin to add you to the group
  that sets them.

## Attach it to a Lightdash agent

Lightdash AI agents take MCP servers per project. The server is added once to the Operations Project and then
enabled on each agent that should use it.

1. In the Operations Project, open the AI agent settings and add an MCP server:
   - **Name:** `telemetry`
   - **URL:** `https://telemetry-mcp.example.com/mcp`
   - **Auth type:** `oauth`
   - **Credential scope:** `user`, so each person signs in to Okta as themselves. Leave OAuth credential sharing
     off. A shared credential would make every agent user query as the one person who signed in, with that
     person's grants and that person's name in the audit log.
2. Sign in when Lightdash asks. Lightdash reads the server's protected-resource metadata, sends you to Okta, and
   keeps the resulting token for your Lightdash user only.
3. Open the agent's settings and enable the `telemetry` MCP server for it. Lightdash lists the server's tools; keep
   the ones the agent should use.
4. Ask the agent something that needs telemetry, for example "what was the p95 latency of the API over the last
   hour?". The tool calls show in the thread.

Use `bearer` only for a quick local test with a token you pasted yourself. Okta access tokens expire, and a bearer
credential is never refreshed.

## Attach it to Claude Code

Add the server over streamable HTTP:

```sh
claude mcp add --transport http telemetry https://telemetry-mcp.example.com/mcp
```

Add `--scope user` to make it available in every project, or `--scope project` to share it through the repo's
`.mcp.json`; the default scope is the current project for you only.

Then, inside Claude Code:

1. Run `/mcp`, pick `telemetry` and choose to authenticate. Claude Code gets a `401` from the server, follows the
   `WWW-Authenticate` challenge to the protected-resource metadata, and opens Okta in your browser.
2. Sign in to Okta. Claude Code stores the token and refreshes it as Okta allows.
3. Run `/mcp` again: `telemetry` shows as connected with its tools. Ask a question that needs telemetry, or call a
   tool by name, for example "use list_sources to show me the Telemetry Sources".

`claude mcp list` shows every MCP server Claude Code knows and whether it answers; `claude mcp remove telemetry`
detaches it.

The Okta app behind `OKTA_AUDIENCE` must accept Claude Code as an OAuth client (with the loopback redirect Claude
Code uses). If sign-in fails at Okta with an unknown-client or redirect error, that is Okta app setup, not this
server.

## Auth

The server is an OAuth 2.1 resource server for Okta. It never sees a password, holds no Okta client secret and
issues no Okta tokens: an MCP client gets an Okta access token and sends it as a bearer token on every request to
`/mcp`. The flow, end to end:

1. **Challenge.** A request to `POST /mcp` without a bearer token, or with one that fails any check below, gets
   `401` and a `WWW-Authenticate: Bearer ... resource_metadata="https://telemetry-mcp.example.com/.well-known/oauth-protected-resource/mcp"`
   header. When a token was sent but refused, the header also carries `error="invalid_token"` and a short reason.
   The server never echoes the token back.
2. **Protected-resource metadata.** The client fetches `/.well-known/oauth-protected-resource/mcp` (also served at
   `/.well-known/oauth-protected-resource`). It names the resource (`https://telemetry-mcp.example.com/mcp`) and
   the authorization server, which is the Okta issuer `OKTA_ISSUER`.
3. **Okta.** The client signs the person in through Okta's authorization-code flow with PKCE and gets an access
   token for the `OKTA_AUDIENCE` audience. It retries `/mcp` with `Authorization: Bearer <token>`.
4. **Token checks.** The server checks the token against Okta's JWKS (`OKTA_JWKS_URI`, by default
   `${OKTA_ISSUER}/v1/keys`):
   - The signature must be RS256 and verify against a key in the JWKS. `none`, HMAC and every other algorithm are
     refused before any key is looked up.
   - `iss` must equal `OKTA_ISSUER` exactly, `aud` must be (or contain) `OKTA_AUDIENCE`, `exp` must be in the
     future and `nbf`, when present, must not be, with 30 s of allowed clock skew.
   - The JWKS is fetched on the first request, not at startup, and cached. When Okta rotates keys, a token signed
     with an unknown `kid` causes one refetch (at most one per second, shared by concurrent requests), so a new key
     is accepted at once. If Okta can't be reached the request gets a `401`: the server fails closed.
5. **Lightdash user.** The server looks up the token's `email` claim (or an email-shaped `sub`) in Lightdash with
   its service account (`LIGHTDASH_API_TOKEN`). Only an active Lightdash user whose email matches exactly counts. A
   caller with no Lightdash user gets an MCP session with no tools; each tool call says why.
6. **User attributes.** The server reads that user's Lightdash user attributes, resolved as Lightdash does: the
   user's own value, else a group's, else the attribute's default. Four of them matter, and each is true only when
   its value is exactly `"true"`:

   | User attribute         | Opens                                                                         |
   | ---------------------- | ----------------------------------------------------------------------------- |
   | `platform_read`        | `platform_schema`, `platform_query`, `platform_explain`, `ask_data`           |
   | `platform_explain`     | `platform_explain` only                                                       |
   | `platform_write`       | `write_preview`                                                               |
   | `telemetry_restricted` | nothing through MCP (see below)                                               |

   The user and the user attributes are cached per person for `MCP_USER_CACHE_TTL_MS` (60 s by default), so a
   change in Lightdash reaches the server within that time.
7. **`hrx.identity` tokens.** For each query the server mints a short-lived identity token (CONTRACTS §3), signed
   with `HRX_IDENTITY_SECRET`, and hands it to the Federation Engine: `SET hrx.identity = '<token>'` on the
   Postgres-wire path, or in the request to the engine's HTTP port. The token carries `iss = "telemetry-mcp"`, the
   Lightdash user's uuid and email, the four user attributes, `agent = true`, the audit details (with source `mcp`
   and the `description` and ticket the tool was given) and a lifetime of 60 s (CONTRACTS allows up to 300 s). The Federation Engine
   checks the signature and the expiry, then enforces the grants itself; the server's own checks only fail sooner
   with a clearer message.

Because every MCP identity token says `agent = true`, Restricted Telemetry is never readable through MCP, even for a
person who has `telemetry_restricted`. The engine refuses it to agents, and the tool's error says that no user
attribute changes this. Read Restricted Telemetry in Lightdash's Investigate instead.

The Okta access token itself never reaches the Federation Engine or Lightdash, and the server's logs redact every
token-shaped string.

## Write Mode through MCP: Preview only

`write_preview` runs one `INSERT`, `UPDATE` or `DELETE` on the Platform Database as a Preview: the Federation Engine
runs it in a transaction, reports the rows affected and the `RETURNING` rows, then rolls it back. It needs the
`platform_write` user attribute and a `description`, and each Preview is an Audited Query.

Nothing in the MCP server can commit a Write Mode statement:

- There is no commit tool.
- `write_preview` has no mode argument.
- The server only ever asks the engine for a Preview, and the engine refuses any other mode from a token with
  `agent = true`.

Committing a write is a human action in Lightdash's Write Mode, after reading the Preview there. An agent can never
commit one, whatever its prompt says.
