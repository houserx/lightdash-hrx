# ENG-1799 end-to-end demo

The demo stack lives in `demo/eng-1799/`: `demo/eng-1799/up.sh` starts it on ephemeral local ports and prints
every URL, `demo/eng-1799/down.sh` stops it. Later sections (prerequisites, the one command, presenting live, the
scenario timeline, the scenes and music) are added as the demo is built.

## Frontend mode

The demo serves the Lightdash UI as the **production build served by the backend**, not the Vite dev server.

- `bash ./init.sh` (through `scripts/eng-1799/init-demo.sh`) runs `pnpm -F frontend build` into
  `packages/frontend/build`, and only again when the frontend or a package it bundles (common, visualization,
  formula) changed. A cold build takes several minutes; a warm `init.sh` skips it.
- The backend's `App` serves that directory itself (`/assets/*` and the `index.html` catch-all), so the UI is at
  the same URL `up.sh` prints as `up.sh: Lightdash: http://127.0.0.1:<port>`. There is no second process and no
  second port.
- `up.sh` refuses to start when `packages/frontend/build/index.html` is missing, and after the backend is healthy
  it checks that `/login` returns the UI.

Why not the dev server:

- One process and one port: the stack, the acceptance checks and the recorded scenes all use the URL in
  `.state/stack.json`, and the backend's session cookie and API calls share that origin with no proxy.
- No file watchers or on-demand compilation while presenting or recording: pages load at production speed
  and the bundle is the one that ships.
- The dev server is for working on the frontend. To use it against the demo backend, run
  `PORT=<printed Lightdash port> pnpm -F frontend dev` yourself (its proxy sends `/api` to `PORT`, default
  8080); the demo does not.

What you see: on a fresh stack without a demo user the UI opens the first-run sign-up page (`/register`); once the
seed has created the demo user it opens the sign-in page (`/login`). Expect 401 responses from `/api/v1/user/account`
and `/api/v1/org` in the browser console before signing in; that is Lightdash checking for a session. The UI loads
the Inter font from Google Fonts; offline it falls back to a system font and works the same.

If you change frontend code, re-run `bash ./init.sh` to rebuild, then `demo/eng-1799/down.sh` and
`demo/eng-1799/up.sh`.

## Dashboards as code

The demo's dashboards live in `demo/eng-1799/content/` as Lightdash content as code (`virtual-views/`, `charts/`,
`dashboards/`). On every fresh stack, `up.sh`'s seed (`demo/eng-1799/stack/seed.ts`) creates a personal access
token for the demo user and runs `lightdash upload` from the CLI's source, then checks that the dashboards and
their Tiles are there. The CLI runs with `HOME` under `.state/cli-home` (it writes `~/.config/lightdash`) and with
`demo/eng-1799/stack/no-network.mjs` preloaded, because it would otherwise send usage analytics and check for
upgrades over the internet. To change a dashboard, edit the YAML and restart the stack. Alternatively, upload by
hand with the token in `.state/run/seed.json` (`lightdash.apiToken`).

**Pharmacy Ops overview** has a Dashboard Time Range (default the last 30 minutes, refresh 30 s) mapped to every
Tile. Its Tiles are all built-in Lightdash charts, so no chart registry or licence is needed:

| Tile | Chart | What it shows |
|---|---|---|
| Current fill queue backlog | big number | the latest `hrx_fill_queue_backlog{queue="fill"}` sample, red at 100 and above (conditional formatting) |
| Fill queue backlog | cartesian line | the fill queue's backlog over time, with a dashed threshold line at 100, the Alert Rule threshold |
| Peak backlog by queue | horizontal bar, 0 to 200 | the bar gauge: each queue's highest backlog in the range |
| Queue status | table | each queue's peak backlog, plus a Status column whose value mappings (Grafana's shape) read OK, Elevated or Backlogged |

The charts query the virtual view `hrx_fill_queue_backlog`: `promql('hrx_fill_queue_backlog', now() - 6 hours,
now(), '15s')` on the Federation Engine. Explore charts don't receive the reserved `__from`/`__to` parameters,
which only reach SQL charts, so the view's window is fixed at 6 hours. The Dashboard Time Range filters each Tile
on `ts` inside that window, so ranges longer than 6 hours show only the last 6 hours.

**Platform DB** has three SQL chart Tiles over the synthetic Platform Database. Each one wraps an aggregate in
`platform_query('...')`, so it is an Audited Query that runs as the signed-in user, who needs `platform_read`. No
Tile selects a row-level column:

| Tile | Chart | Inner SQL (Platform Database) |
|---|---|---|
| Orders by status | vertical bar | `count(*)` of `orders` per `status` |
| Open fills by queue | vertical bar | `fills` with no `completed_at`, joined to `queues`, counted per queue name |
| Shipments by carrier | table | `count(*)` of `shipments` per `carrier` and `status` |

The engine refuses an Audited Query that has no description, and saved SQL charts don't carry an audit block of
their own. Lightdash therefore sends the **saved chart's description** as the Audited Query description, for a
saved SQL chart and for a dashboard SQL chart Tile (the Tile's uuid goes in as the resource). That is why every
chart here has a description. Each Tile run leaves two audit records, one for the column-discovery probe and one
for the run.
