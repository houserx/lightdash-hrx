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
