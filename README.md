# home-mac

Control-plane server for this Mac. It exposes `mac.stf.lol` and lets GitHub Actions notify the machine to redeploy configured personal repo containers.

## Server

`src/index.ts` starts a Bun HTTP server on `0.0.0.0:3000`.

- `GET /` returns `{ "ok": true }`.
- `GET /public/<filename>` serves flat files from `~/Sites/mac.stf.lol`.
- `POST /update/:repo` requires `Authorization: Bearer <UPDATE_BEARER_KEY>`.
- Unknown repos fail before deployment work starts. Add supported repos in `src/repoConfig.ts`.
- Valid updates run `src/setupRepoContainer.ts deploy --repo <repo> --defer-router-restart` and stream deployment logs back as `text/plain`.
- Successful streamed deploys end with `DEPLOY_OK repo=<repo>`. Failed streamed deploys end with `DEPLOY_FAILED repo=<repo>`.

`UPDATE_BEARER_KEY` is defined through env-manager and typed in the generated `src/env.ts`.

Publish a file with:

```sh
mkdir -p ~/Sites/mac.stf.lol
cp report.html ~/Sites/mac.stf.lol/report.html
```

It will be available at `https://mac.stf.lol/public/report.html`. Public filenames are limited to letters, numbers, dots, dashes, and underscores; subdirectories are not exposed.

## Always-On Service

Install or refresh the user LaunchAgents with:

```sh
bun run install-service
```

This writes and loads:

- `~/Library/LaunchAgents/lol.stf.mac.plist`: runs the Bun server.
- `~/Library/LaunchAgents/lol.stf.mac.watchdog.plist`: checks `http://127.0.0.1:3000/` every 30 seconds and kickstarts the server if it is down.

Logs live in:

```sh
~/Library/Logs/mac.stf.lol/
```

The service command runs `env-manager down` if available before starting the server, then starts `bun src/index.ts`.

## Cloudflare Tunnel

The Cloudflare router container reads:

```sh
/Users/stefan/code/.repo-containers/cloudflared-router.yml
```

`src/setupRepoContainer.ts` preserves the control-plane route when regenerating that config:

```yaml
- hostname: mac.stf.lol
  service: http://192.168.64.1:3000
```

`192.168.64.1` is the host gateway address from Apple container networking, allowing the `paas-cloudflared` container to reach the Bun server running on the Mac.

Webhook-triggered deploys defer the Cloudflare router restart until after the HTTP response closes. Otherwise the request would be cut off by restarting the same tunnel carrying the response.

GitHub-hosted runners may be challenged by Cloudflare before requests reach the tunnel. The zone needs a targeted security skip/bypass rule for authenticated update requests, for example matching `mac.stf.lol` with path `/update/*`. The Bun server still enforces `UPDATE_BEARER_KEY`; the Cloudflare rule is only to let the request reach that auth check.

## Repo Containers

`src/setupRepoContainer.ts` deploys configured repos by pulling from GitHub, building an Apple `container` image, starting the app container, refreshing Cloudflare routing, and installing a per-app LaunchAgent.

Supported repos are registered in `src/repoConfig.ts`. Unknown repos intentionally fail with instructions to add config first.

Runtime state, generated build contexts, app data, and router config live under:

```sh
/Users/stefan/code/.repo-containers
```

## Useful Commands

```sh
bun run dev
bun run start
bun run install-service
bun run lint
bunx tsc --noEmit
```

`bun run test` currently exits with "No tests found!" because this repo has no test files.
