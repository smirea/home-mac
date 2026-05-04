# Stack

- Runtime: Bun
- Language: TypeScript
- Linting: Oxlint
- Git Hooks: Lefthook

# Repo Container Script

- `src/setupRepoContainer.ts` is the global deployment script for small personal repos on this Mac. It pulls GitHub repos, builds Apple `container` images, runs the app container, updates the Cloudflare tunnel router container, and installs a LaunchAgent so the app is restarted after boot/login.
- `/Users/stefan/bin/setup-repo-container` is a symlink to that script and should stay executable.
- `src/repoConfig.ts` is the registry of supported repos. Add a repo there before deploying it; unknown repos should fail fast with instructions. Use `nodeClientServer()` for the common Bun/Node client+server shape.
- Runtime state, generated container build contexts, env files, and per-app writable data live under `/Users/stefan/code/.repo-containers`.
