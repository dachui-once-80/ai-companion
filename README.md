## Local development

Companion HTTP and the Vite `/api` proxy both require `COMPANION_ACCESS_TOKEN`
(at least 32 characters). For day-to-day work, use the token-aware launchers
below so server and Vite share one token from a local file.

### 1. Create the access token file (once)

From the repository root:

```bash
mkdir -p .local
openssl rand -hex 32 > .local/companion-token
chmod 600 .local/companion-token
```

The file must contain at least 32 characters after trailing newlines are stripped.
`.local/` is gitignored — do not commit this file.

The server still loads other secrets (for example `GEMINI_API_KEY`) from
`apps/server/.env` via dotenv when the server process starts. That path is
separate from `.local/companion-token`.

### 2. Start server and web together

```bash
pnpm dev:local
```

This runs `scripts/dev-with-token.mjs` in `all` mode: it reads
`.local/companion-token`, sets `COMPANION_ACCESS_TOKEN` in the child
environment, and starts both `pnpm --filter server dev` and
`pnpm --filter web dev`.

### 3. Start server or web separately

```bash
pnpm dev:server:local   # server only
pnpm dev:web:local      # Vite only
```

Use the same `.local/companion-token` for both so the proxy and API share one
token.

### 4. Stop

In the terminal running the launcher, press **Ctrl+C** (SIGINT), or send
SIGTERM to that process. The launcher tries to terminate the `pnpm` processes
and their children. On macOS/Linux it recursively cleans up via `pgrep`; in
edge cases some processes may still remain. If you started server and web in
two terminals, stop each with Ctrl+C.

### 5. Extra environment variables

The launcher builds child env as `{ ...process.env, COMPANION_ACCESS_TOKEN }`.
Variables you already exported in the shell — such as `COMPANION_DB`,
`COMPANION_OFFLINE_TEST`, `HTTP_PROXY`, `HTTPS_PROXY`, `GEMINI_API_KEY` — are
inherited. Only `COMPANION_ACCESS_TOKEN` is replaced with the file contents.

`COMPANION_DB` and `COMPANION_OFFLINE_TEST=1` are only for intentional
isolation tests. Do not set them unless you understand the impact, and never
point an offline-test setup at the real business database by mistake.

Example (isolated DB for a local experiment):

```bash
export COMPANION_DB="/path/to/temp/companion.db"
export COMPANION_OFFLINE_TEST=1
pnpm dev:server:local
```

### 6. Security notes

- Do not share the token or paste it into chat, tickets, or screenshots.
- Do not commit `.local/companion-token` (or any copy of it).
- Prefer `chmod 600` on the token file.
- `pnpm dev:server` and `pnpm dev:web` do **not** load `.local/companion-token`.
  They only see `COMPANION_ACCESS_TOKEN` if it is already in the environment
  (or, for the server, provided via `apps/server/.env` / dotenv). Prefer the
  `:local` scripts for normal development.
