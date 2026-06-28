#!/usr/bin/env bun

import { lstat, mkdir, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoConfig, type ContainerConfig, type RepoConfig } from './repoConfig.ts';

type Cli = {
	command: string;
	positionals: string[];
	options: Map<string, string[]>;
};

type AppState = {
	name: string;
	repo: string;
	repoFullName: string;
	repoDir: string;
	dataDir: string;
	domain: string;
	hostname: string;
	tunnelName: string;
	containerName: string;
	image: string;
	containerIp?: string;
	hostPort: number;
	containerPort: number;
	apiPort: number;
	memory: string;
	cpus: string;
	updatedAt: string;
};

type TunnelState = {
	name: string;
	id: string;
	credentialsFile: string;
	containerName: string;
	configPath: string;
	updatedAt: string;
};

type State = {
	apps: Record<string, AppState>;
	tunnels: Record<string, TunnelState>;
};

type ContainerListEntry = {
	status?: string;
	configuration?: {
		id?: string;
		image?: { reference?: string };
	};
	networks?: Array<{ ipv4Address?: string }>;
};

type ImageListEntry = {
	reference?: string;
};

const home = homedir();
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const codeDir = path.join(home, 'code');
const stateDir = path.join(codeDir, '.repo-containers');
const appsDir = path.join(stateDir, 'apps');
const logsDir = path.join(home, 'Library', 'Logs', 'repo-containers');
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const statePath = path.join(stateDir, 'state.json');
const cloudflaredConfigPath = path.join(home, '.cloudflared', 'config.yml');
const defaultDomain = 'stf.lol';
const defaultTunnelName = 'default';
const controlPlaneHostname = 'mac.stf.lol';
const controlPlaneService = 'http://192.168.64.1:3000';
const cloudflaredImage = 'cloudflare/cloudflared:2026.3.0';
const pathEntries = [
	path.join(home, '.bun', 'bin'),
	path.join(home, 'bin'),
	'/opt/homebrew/bin',
	'/usr/local/bin',
	'/usr/bin',
	'/bin',
	'/usr/sbin',
	'/sbin',
];

process.env.PATH = `${pathEntries.join(':')}:${process.env.PATH ?? ''}`;

const cli = parseCli(Bun.argv.slice(2));

if (cli.command === 'deploy') {
	await deploy(cli);
} else if (cli.command === 'start') {
	await startFromCli(cli);
} else if (cli.command === 'refresh-router') {
	await refreshRouterFromCli(cli);
} else if (cli.command === 'cleanup') {
	await cleanupFromCli(cli);
} else if (cli.command === 'status') {
	await status();
} else {
	throw new Error(`Unknown command: ${cli.command}`);
}

function parseCli(argv: string[]): Cli {
	const options = new Map<string, string[]>();
	const positionals: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith('--')) {
			positionals.push(arg);
			continue;
		}

		const raw = arg.slice(2);
		const eqIndex = raw.indexOf('=');
		const key = eqIndex === -1 ? raw : raw.slice(0, eqIndex);
		const inlineValue = eqIndex === -1 ? undefined : raw.slice(eqIndex + 1);
		const value = inlineValue ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true');
		options.set(key, [...(options.get(key) ?? []), value]);
	}

	const commands = new Set(['deploy', 'start', 'refresh-router', 'cleanup', 'status']);
	const command = options.has('status') ? 'status' : commands.has(positionals[0]) ? positionals.shift()! : 'deploy';
	return { command, positionals, options };
}

async function deploy(cli: Cli) {
	await ensureBaseDirs();

	const repoArg = option(cli, 'repo') ?? cli.positionals[0] ?? 'decideroo';
	const repo = resolveRepo(repoArg);
	const config = requireRepoConfig(repo.name);
	await ensureDependencies();
	const name = sanitizeName(option(cli, 'name') ?? repo.name);
	const domain = option(cli, 'domain') ?? defaultDomain;
	const subdomain = option(cli, 'subdomain') ?? config.subdomain;
	const hostname = option(cli, 'hostname') ?? `${subdomain}.${domain}`;
	const tunnelName = sanitizeName(option(cli, 'tunnel') ?? defaultTunnelName);
	const containerName = `paas-${name}`;
	const appDir = path.join(appsDir, name);
	const appDataDir = path.join(appDir, 'data');
	const runtimeEnvPath = path.join(appDir, 'runtime.env');
	const buildContextDir = path.join(appDir, 'build-context');
	const containerfilePath = path.join(appDir, 'Containerfile');
	const containerPort = numberOption(cli, 'container-port', 3000);
	const apiPort = numberOption(cli, 'api-port', 3001);
	const hostPort = await chooseHostPort(cli, name);
	const memory = option(cli, 'memory') ?? '1G';
	const cpus = option(cli, 'cpus') ?? '2';
	const tunnel = await resolveTunnelState(cli, tunnelName);

	await mkdir(appDir, { recursive: true });

	const repoInfo = await resolveRepoInfo(repo.spec);
	const repoDir = await ensureRepoCheckout(repoInfo.nameWithOwner, repoInfo.defaultBranchRef.name);
	const dataDir = config.dataDir ? await ensureLinkedAppDataDir(appDataDir, config.dataDir(repoDir)) : appDataDir;
	await runEnvManager(repoDir, name);
	await runProjectChecks(repoDir, cli, config);

	const commit = run('git', ['-C', repoDir, 'rev-parse', '--short=12', 'HEAD'], {
		capture: true,
	}).stdout.trim();
	const image = `local/${containerName}:${commit}`;
	const requiredEnv = {
		API_PORT: String(apiPort),
		CLIENT_PORT: String(containerPort),
		VITE_HOST: hostname,
		VITE_API_URL: `https://${hostname}/api`,
		CLIENT_HOST: hostname,
		DATA_DIR: '/data',
		GAMES_DIR: '/data/games',
		BUN_INSTALL_CACHE_DIR: '/tmp/bun-cache',
		NODE_ENV: 'production',
		...config.runtimeEnv,
		...envOptions(cli),
	};

	await prepareBuildContext(repoDir, buildContextDir);
	await writeStartScript(buildContextDir, config.container);
	await writeNginxConfig(buildContextDir, config.container);
	await writeContainerfile(containerfilePath, config.container, requiredEnv);
	run('container', ['build', '-f', containerfilePath, '-t', image, buildContextDir]);

	await writeRuntimeEnv(repoDir, runtimeEnvPath, requiredEnv);

	const state = await readState();
	state.tunnels[tunnelName] = tunnel;
	state.apps[name] = {
		name,
		repo: repo.spec,
		repoFullName: repoInfo.nameWithOwner,
		repoDir,
		dataDir,
		domain,
		hostname,
		tunnelName,
		containerName,
		image,
		hostPort,
		containerPort,
		apiPort,
		memory,
		cpus,
		updatedAt: new Date().toISOString(),
	};
	await writeState(state);

	await recreateContainer(state.apps[name], runtimeEnvPath);
	await startApp(state.apps[name]);
	await refreshContainerRoute(name, true, option(cli, 'defer-router-restart') !== 'true');
	await ensureCloudflareDns(hostname, domain, tunnel);
	await installAppLaunchAgent(name);
	const routedState = await readState();
	await verifyApp(routedState.apps[name], config.container);
	pruneUnusedRepoImages();

	console.log(`\nDeployed ${name}: https://${hostname}`);
	console.log(`Cloudflared router container: ${tunnel.containerName}`);
}

async function startFromCli(cli: Cli) {
	await ensureBaseDirs();
	const state = await readState();
	const name = sanitizeName(option(cli, 'name') ?? cli.positionals[0] ?? 'decideroo');
	requireRepoConfig(name);
	const app = state.apps[name];
	if (!app) throw new Error(`No app named ${name} in ${statePath}`);
	await ensureContainerRuntime();
	await startApp(app);
	await refreshContainerRoute(name, false);
}

async function refreshRouterFromCli(cli: Cli) {
	await ensureBaseDirs();
	const name = sanitizeName(option(cli, 'name') ?? cli.positionals[0] ?? 'decideroo');
	requireRepoConfig(name);
	await refreshContainerRoute(name, true);
}

async function cleanupFromCli(cli: Cli) {
	await ensureBaseDirs();
	ensureCommand('container');
	await ensureContainerRuntime();

	const deletedImages = pruneUnusedRepoImages();
	if (option(cli, 'builder') === 'true' && option(cli, 'skip-builder') !== 'true') {
		run('container', ['builder', 'delete', '--force'], { allowFailure: true });
		console.log('Deleted builder cache container');
	} else {
		console.log('Kept builder cache; pass --builder to delete it');
	}

	console.log(`Deleted ${deletedImages} unused repo image${deletedImages === 1 ? '' : 's'}`);
}

async function status() {
	const state = await readState();
	const containers = readContainers();
	console.log('Containers');
	for (const container of containers) {
		const id = container.configuration?.id ?? '(unknown)';
		const status = container.status ?? '(unknown)';
		const image = container.configuration?.image?.reference ?? '';
		const addresses = (container.networks ?? [])
			.map(network => network.ipv4Address?.split('/')[0])
			.filter(Boolean)
			.join(',');
		console.log(`${id}\t${status}\t${addresses}\t${image}`);
	}

	console.log('\nApps');
	for (const app of Object.values(state.apps)) {
		const upstream = app.containerIp
			? `${app.containerIp}:${app.containerPort}`
			: `${app.containerName}:${app.containerPort}`;
		console.log(`${app.name} [${appTunnelName(app)}]: https://${app.hostname} -> ${upstream}`);
	}
}

async function ensureBaseDirs() {
	await mkdir(stateDir, { recursive: true });
	await mkdir(appsDir, { recursive: true });
	await mkdir(logsDir, { recursive: true });
	await mkdir(launchAgentsDir, { recursive: true });
}

async function ensureDependencies() {
	ensureCommand('brew');
	await ensureBrewCommand('gh', 'gh');
	await ensureBrewCommand('trash', 'trash');
	await ensureBrewCommand('container', 'container');

	if (!which('cloudflared')) {
		run('brew', ['install', 'cloudflared']);
	}

	await ensureContainerRuntime();
}

async function ensureContainerRuntime() {
	run('brew', ['services', 'start', 'container'], { allowFailure: true });
	run('container', ['system', 'start', '--enable-kernel-install'], { allowFailure: true });
	run('container', ['system', 'status']);
}

async function ensureBrewCommand(command: string, formula: string) {
	if (which(command)) return;
	run('brew', ['install', formula]);
	if (!which(command)) throw new Error(`Expected ${command} after installing ${formula}`);
}

function ensureCommand(command: string) {
	if (!which(command)) throw new Error(`Missing required command: ${command}`);
}

function which(command: string) {
	const paths = (process.env.PATH ?? '').split(':').filter(Boolean);
	for (const directory of paths) {
		const candidate = path.join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return '';
}

async function resolveRepoInfo(repo: string) {
	const result = run('gh', ['repo', 'view', repo, '--json', 'nameWithOwner,defaultBranchRef'], {
		capture: true,
	});
	return JSON.parse(result.stdout) as {
		nameWithOwner: string;
		defaultBranchRef: { name: string };
	};
}

function resolveRepo(repoArg: string) {
	const repoName = repoArg
		.split('/')
		.at(-1)!
		.replace(/\.git$/, '');
	return { spec: repoArg, name: repoName };
}

function requireRepoConfig(repoName: string) {
	const config = repoConfig[repoName];
	if (config) return config;

	throw new Error(
		`No repo config found for "${repoName}". Add it to ${path.join(scriptDir, 'repoConfig.ts')} with something like:\n\n` +
			`export const repoConfig = {\n` +
			`  ...,\n` +
			`  ${JSON.stringify(repoName)}: nodeClientServer({ subdomain: ${JSON.stringify(repoName)} }),\n` +
			`};`,
	);
}

async function ensureRepoCheckout(repoFullName: string, branch: string) {
	const repoName = repoFullName.split('/')[1];
	const repoDir = path.join(codeDir, repoName);
	if (existsSync(path.join(repoDir, '.git'))) {
		run('git', ['-C', repoDir, 'fetch', 'origin', branch]);
		const dirty = run('git', ['-C', repoDir, 'status', '--porcelain'], { capture: true }).stdout.trim();
		if (dirty) {
			const currentBranch = run('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
				capture: true,
			}).stdout.trim();
			const head = run('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { capture: true }).stdout.trim();
			const remote = run('git', ['-C', repoDir, 'rev-parse', `origin/${branch}`], {
				capture: true,
			}).stdout.trim();
			if (currentBranch === branch && head === remote) return repoDir;
			throw new Error(
				`${repoDir} has uncommitted changes and is not at origin/${branch}; commit or stash before deploying`,
			);
		}
		run('git', ['-C', repoDir, 'checkout', branch]);
		run('git', ['-C', repoDir, 'pull', '--ff-only', 'origin', branch]);
		return repoDir;
	}

	run('gh', ['repo', 'clone', repoFullName, repoDir]);
	run('git', ['-C', repoDir, 'checkout', branch]);
	return repoDir;
}

async function ensureLinkedAppDataDir(linkPath: string, targetPath: string) {
	const resolvedLinkPath = path.resolve(linkPath);
	const resolvedTargetPath = path.resolve(targetPath);
	await mkdir(path.dirname(resolvedLinkPath), { recursive: true });
	await mkdir(resolvedTargetPath, { recursive: true });

	if (resolvedLinkPath === resolvedTargetPath) return resolvedLinkPath;

	const existing = await lstat(resolvedLinkPath).catch(error => {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	});
	if (!existing) {
		await symlink(resolvedTargetPath, resolvedLinkPath, 'dir');
		return resolvedLinkPath;
	}
	if (!existing.isSymbolicLink()) {
		throw new Error(`${resolvedLinkPath} already exists and is not a symlink; move it before deploying this repo`);
	}

	const currentTarget = path.resolve(path.dirname(resolvedLinkPath), await readlink(resolvedLinkPath));
	if (currentTarget === resolvedTargetPath) return resolvedLinkPath;

	run('trash', [resolvedLinkPath]);
	await symlink(resolvedTargetPath, resolvedLinkPath, 'dir');
	return resolvedLinkPath;
}

async function runEnvManager(repoDir: string, name: string) {
	const hasEnvSchema = existsSync(path.join(repoDir, '.env'));
	const hasLocalEnv = existsSync(path.join(repoDir, '.env.local'));
	if (!hasEnvSchema && !hasLocalEnv) return;

	if (!which('env-manager')) throw new Error(`${name} needs env-manager, but env-manager is not installed`);
	run('env-manager', ['down'], { cwd: repoDir });
}

async function runProjectChecks(repoDir: string, cli: Cli, config: RepoConfig) {
	if (option(cli, 'skip-project-checks') === 'true') return;
	await runInDirectory(repoDir, config.setup);

	const packageJsonPath = path.join(repoDir, 'package.json');
	const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
		scripts?: Record<string, string>;
	};

	if (packageJson.scripts?.test && option(cli, 'skip-tests') !== 'true') {
		const result = run('bun', ['test'], {
			cwd: repoDir,
			capture: true,
			allowFailure: true,
		});
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		if (result.status !== 0 && !result.stderr.includes('No tests found')) {
			throw new Error('bun test failed');
		}
	}
}

async function runInDirectory(directory: string, fn: () => Promise<void>) {
	const previous = process.cwd();
	process.chdir(directory);
	try {
		await fn();
	} finally {
		process.chdir(previous);
	}
}

async function chooseHostPort(cli: Cli, name: string) {
	const explicit = option(cli, 'host-port');
	if (explicit) return Number(explicit);

	const state = await readState();
	const current = state.apps[name]?.hostPort;
	if (current) return current;

	const used = new Set(Object.values(state.apps).map(app => app.hostPort));
	for (let port = 41000; port < 42000; port += 1) {
		if (used.has(port)) continue;
		if (await isPortFree(port)) return port;
	}

	throw new Error('No free localhost ports in 41000-41999');
}

async function isPortFree(port: number) {
	const net = await import('node:net');
	return await new Promise<boolean>(resolve => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => {
			server.close(() => resolve(true));
		});
		server.listen(port, '127.0.0.1');
	});
}

async function prepareBuildContext(repoDir: string, buildContextDir: string) {
	if (existsSync(buildContextDir)) run('trash', [buildContextDir]);
	await mkdir(buildContextDir, { recursive: true });

	const archivePath = path.join(path.dirname(buildContextDir), 'source.tar');
	if (existsSync(archivePath)) run('trash', [archivePath]);
	run('git', ['-C', repoDir, 'archive', '--format=tar', '--output', archivePath, 'HEAD']);
	run('tar', ['-xf', archivePath, '-C', buildContextDir]);
	run('trash', [archivePath]);
}

async function writeStartScript(buildContextDir: string, container: ContainerConfig) {
	if (container.type === 'bun-server') {
		await writeFile(
			path.join(buildContextDir, 'paas-start.sh'),
			`#!/usr/bin/env sh
set -eu

: "\${CLIENT_PORT:?CLIENT_PORT is required}"

mkdir -p /tmp/bun-cache
exec bun src/index.ts --port "$CLIENT_PORT" --open false
`,
			{ mode: 0o755 },
		);
		return;
	}

	await writeFile(
		path.join(buildContextDir, 'paas-start.sh'),
		`#!/usr/bin/env sh
set -eu

: "\${API_PORT:?API_PORT is required}"
: "\${CLIENT_PORT:?CLIENT_PORT is required}"

mkdir -p /tmp/bun-cache
mkdir -p /tmp/nginx-client-body /tmp/nginx-proxy /tmp/nginx-fastcgi /tmp/nginx-uwsgi /tmp/nginx-scgi

bun server/src/index.ts &
api_pid=$!

nginx -c /app/paas-nginx.conf -g "daemon off;" &
client_pid=$!

trap 'kill "$api_pid" "$client_pid" 2>/dev/null || true' TERM INT

wait "$client_pid"
status=$?
kill "$api_pid" 2>/dev/null || true
wait "$api_pid" 2>/dev/null || true
exit "$status"
`,
		{ mode: 0o755 },
	);
}

async function writeNginxConfig(buildContextDir: string, container: ContainerConfig) {
	if (container.type === 'bun-server') return;

	await writeFile(
		path.join(buildContextDir, 'paas-nginx.conf'),
		`pid /tmp/nginx.pid;
error_log /dev/stderr info;

events {}

http {
	include /etc/nginx/mime.types;
	access_log /dev/stdout;
	client_body_temp_path /tmp/nginx-client-body;
	proxy_temp_path /tmp/nginx-proxy;
	fastcgi_temp_path /tmp/nginx-fastcgi;
	uwsgi_temp_path /tmp/nginx-uwsgi;
	scgi_temp_path /tmp/nginx-scgi;

	map $http_upgrade $connection_upgrade {
		default upgrade;
		'' '';
	}

	server {
		listen 0.0.0.0:3000;
		root /app/client/dist;
		index index.html;

		location = /api {
			proxy_pass http://127.0.0.1:3001/;
			proxy_http_version 1.1;
			proxy_buffering off;
			proxy_cache off;
			proxy_read_timeout 1h;
			proxy_set_header Host $host;
			proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
			proxy_set_header X-Forwarded-Proto $scheme;
			proxy_set_header Upgrade $http_upgrade;
			proxy_set_header Connection $connection_upgrade;
		}

		location /api/ {
			proxy_pass http://127.0.0.1:3001/;
			proxy_http_version 1.1;
			proxy_buffering off;
			proxy_cache off;
			proxy_read_timeout 1h;
			proxy_set_header Host $host;
			proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
			proxy_set_header X-Forwarded-Proto $scheme;
			proxy_set_header Upgrade $http_upgrade;
			proxy_set_header Connection $connection_upgrade;
		}

		location / {
			try_files $uri $uri/ /index.html;
		}
	}
}
`,
	);
}

async function writeContainerfile(
	containerfilePath: string,
	container: ContainerConfig,
	buildEnv: Record<string, string>,
) {
	if (container.type === 'bun-server') {
		await writeFile(
			containerfilePath,
			`FROM oven/bun:1.3.6-slim

WORKDIR /app
COPY . .
RUN bun -e "const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); if (pkg.scripts) delete pkg.scripts.prepare; fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));"
RUN bun install --frozen-lockfile
RUN chmod +x /app/paas-start.sh
ENV BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
EXPOSE 3000
CMD ["/app/paas-start.sh"]
`,
		);
		return;
	}

	await writeFile(
		containerfilePath,
		`FROM oven/bun:1.3.6-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends nginx-light python3 make g++
COPY . .
RUN bun -e "const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); if (pkg.scripts) delete pkg.scripts.prepare; fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));"
RUN bun install --frozen-lockfile
RUN cd client && CLIENT_PORT=${quoteEnv(buildEnv.CLIENT_PORT)} CLIENT_HOST=${quoteEnv(buildEnv.CLIENT_HOST)} VITE_HOST=${quoteEnv(buildEnv.VITE_HOST)} VITE_API_URL=${quoteEnv(buildEnv.VITE_API_URL)} bunx --bun vite build
RUN chmod +x /app/paas-start.sh
ENV BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
EXPOSE 3000
CMD ["/app/paas-start.sh"]
`,
	);
}

async function writeRuntimeEnv(repoDir: string, runtimeEnvPath: string, required: Record<string, string>) {
	const env = {
		...(await readEnvFile(path.join(repoDir, '.env'))),
		...(await readEnvFile(path.join(repoDir, '.env.local'))),
		...required,
	};
	const body = Object.entries(env)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${quoteEnv(value)}`)
		.join('\n');
	await writeFile(runtimeEnvPath, `${body}\n`, { mode: 0o600 });
}

async function readEnvFile(filePath: string) {
	if (!existsSync(filePath)) return {};
	const body = await readFile(filePath, 'utf8');
	const env: Record<string, string> = {};
	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		env[key] = parseEnvValue(trimmed.slice(eqIndex + 1));
	}
	return env;
}

function parseEnvValue(raw: string) {
	const value = raw.trim();
	const quote = value[0];
	if (quote === '"' || quote === "'") {
		const end = value.indexOf(quote, 1);
		if (end !== -1) return value.slice(1, end);
	}
	return value.replace(/\s+#.*$/, '').trim();
}

function quoteEnv(value: string) {
	if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
	return JSON.stringify(value);
}

function envOptions(cli: Cli) {
	const values = cli.options.get('env') ?? [];
	const env: Record<string, string> = {};
	for (const value of values) {
		const eqIndex = value.indexOf('=');
		if (eqIndex === -1) throw new Error(`Invalid --env value: ${value}`);
		env[value.slice(0, eqIndex)] = value.slice(eqIndex + 1);
	}
	return env;
}

async function recreateContainer(app: AppState, runtimeEnvPath: string) {
	await mkdir(app.dataDir, { recursive: true });
	run('container', ['delete', '--force', app.containerName], { allowFailure: true });
	run('container', [
		'create',
		'--name',
		app.containerName,
		'--read-only',
		'--tmpfs',
		'/tmp',
		'--mount',
		`type=bind,source=${app.dataDir},target=/data`,
		'--env-file',
		runtimeEnvPath,
		'--cpus',
		app.cpus,
		'--memory',
		app.memory,
		'--publish',
		`127.0.0.1:${app.hostPort}:${app.containerPort}`,
		app.image,
	]);
}

async function startApp(app: AppState) {
	const running = run('container', ['list', '--quiet'], {
		capture: true,
		allowFailure: true,
	}).stdout;
	if (running.split(/\s+/).includes(app.containerName)) return;

	const result = run('container', ['start', app.containerName], {
		capture: true,
		allowFailure: true,
	});
	if (result.status !== 0) {
		const refreshed = run('container', ['list', '--quiet'], {
			capture: true,
			allowFailure: true,
		}).stdout;
		if (!refreshed.split(/\s+/).includes(app.containerName)) {
			throw new Error(result.stderr || `Failed to start ${app.containerName}`);
		}
	}
}

async function refreshContainerRoute(name: string, force: boolean, restartRouter = true) {
	const state = await readState();
	const app = state.apps[name];
	if (!app) throw new Error(`No app named ${name} in ${statePath}`);
	const tunnel = await ensureTunnelInState(state, appTunnelName(app));

	const containerIp = getContainerIp(app.containerName);
	const changed = app.containerIp !== containerIp;
	if (app.containerIp !== containerIp) {
		app.containerIp = containerIp;
		app.updatedAt = new Date().toISOString();
		await writeState(state);
	}

	const currentState = await readState();
	const currentTunnel = await ensureTunnelInState(currentState, tunnel.name);
	await writeCloudflaredRouterConfig(currentState, currentTunnel);
	if (restartRouter && (force || changed || !isContainerRunning(currentTunnel.containerName))) {
		await recreateCloudflaredRouter(currentTunnel);
	}
}

function getContainerIp(containerName: string) {
	const raw = run('container', ['inspect', containerName], { capture: true }).stdout;
	const parsed = JSON.parse(raw);
	const container = Array.isArray(parsed) ? parsed[0] : parsed;
	const ipv4 = container?.networks?.find((network: { ipv4Address?: string }) => network.ipv4Address)?.ipv4Address;
	if (!ipv4) throw new Error(`Could not find IPv4 address for ${containerName}`);
	return ipv4.split('/')[0];
}

function isContainerRunning(containerName: string) {
	const running = run('container', ['list', '--quiet'], {
		capture: true,
		allowFailure: true,
	}).stdout;
	return running.split(/\s+/).includes(containerName);
}

function readContainers(): ContainerListEntry[] {
	const result = spawnSync('container', ['list', '--all', '--format', 'json'], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 50,
	});
	if (result.status !== 0) {
		throw new Error(`container list failed\n${result.stderr ?? ''}`);
	}
	return JSON.parse(result.stdout || '[]') as ContainerListEntry[];
}

function readImages(): ImageListEntry[] {
	const result = spawnSync('container', ['image', 'list', '--format', 'json'], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 50,
	});
	if (result.status !== 0) {
		throw new Error(`container image list failed\n${result.stderr ?? ''}`);
	}
	return JSON.parse(result.stdout || '[]') as ImageListEntry[];
}

function pruneUnusedRepoImages() {
	const referencedImages = new Set(
		readContainers()
			.map(container => container.configuration?.image?.reference)
			.filter((reference): reference is string => Boolean(reference)),
	);
	const staleImages = readImages()
		.map(image => image.reference)
		.filter((reference): reference is string => Boolean(reference))
		.filter(reference => reference.startsWith('local/paas-') && !referencedImages.has(reference));

	for (const image of staleImages) {
		run('container', ['image', 'delete', image], { allowFailure: true });
	}

	return staleImages.length;
}

async function startContainer(containerName: string) {
	if (isContainerRunning(containerName)) return;
	const result = run('container', ['start', containerName], {
		capture: true,
		allowFailure: true,
	});
	if (result.status !== 0 && !isContainerRunning(containerName)) {
		throw new Error(result.stderr || `Failed to start ${containerName}`);
	}
}

async function writeCloudflaredRouterConfig(state: State, tunnel: TunnelState) {
	const credentialsFileName = path.basename(tunnel.credentialsFile);
	const controlPlaneRule =
		tunnel.name === defaultTunnelName
			? `  - hostname: ${controlPlaneHostname}\n    service: ${controlPlaneService}`
			: '';
	const appRules = Object.values(state.apps)
		.filter(app => appTunnelName(app) === tunnel.name && app.containerIp)
		.sort((left, right) => left.hostname.localeCompare(right.hostname))
		.map(app => `  - hostname: ${app.hostname}\n    service: http://${app.containerIp}:${app.containerPort}`)
		.join('\n');
	const rules = [controlPlaneRule, appRules].filter(Boolean).join('\n');

	await writeFile(
		tunnel.configPath,
		`tunnel: ${tunnel.id}
credentials-file: /etc/cloudflared-host/${credentialsFileName}

ingress:
${rules}
  - service: http_status:404
`,
	);
}

async function resolveTunnelState(cli: Cli, tunnelName: string): Promise<TunnelState> {
	const state = await readState();
	const explicitId = option(cli, 'tunnel-id') ?? process.env.CLOUDFLARED_TUNNEL_ID;
	const explicitCredentials = option(cli, 'credentials-file') ?? process.env.CLOUDFLARED_CREDENTIALS_FILE;

	if (explicitId || explicitCredentials) {
		if (!explicitId || !explicitCredentials) {
			throw new Error('--tunnel-id and --credentials-file must be provided together');
		}
		return buildTunnelState(tunnelName, explicitId, expandHome(explicitCredentials));
	}

	const existing = state.tunnels[tunnelName];
	if (existing) return existing;

	if (tunnelName !== defaultTunnelName) {
		throw new Error(`Unknown tunnel ${tunnelName}; pass --tunnel-id and --credentials-file the first time you use it`);
	}

	const hostTunnel = await readHostTunnelConfig();
	return buildTunnelState(tunnelName, hostTunnel.id, hostTunnel.credentialsFile);
}

async function ensureTunnelInState(state: State, tunnelName: string) {
	const existing = state.tunnels[tunnelName];
	if (existing) return existing;

	if (tunnelName !== defaultTunnelName) {
		throw new Error(`No tunnel named ${tunnelName} in ${statePath}`);
	}

	const hostTunnel = await readHostTunnelConfig();
	const tunnel = buildTunnelState(tunnelName, hostTunnel.id, hostTunnel.credentialsFile);
	state.tunnels[tunnelName] = tunnel;
	await writeState(state);
	return tunnel;
}

function buildTunnelState(tunnelName: string, id: string, credentialsFile: string): TunnelState {
	const expandedCredentialsFile = expandHome(credentialsFile);
	if (!existsSync(expandedCredentialsFile)) {
		throw new Error(`Missing tunnel credentials file: ${expandedCredentialsFile}`);
	}

	return {
		name: tunnelName,
		id,
		credentialsFile: expandedCredentialsFile,
		containerName: tunnelContainerName(tunnelName),
		configPath: tunnelConfigPath(tunnelName),
		updatedAt: new Date().toISOString(),
	};
}

async function readHostTunnelConfig() {
	if (!existsSync(cloudflaredConfigPath)) {
		throw new Error(`Missing cloudflared config at ${cloudflaredConfigPath}`);
	}

	const config = await readFile(cloudflaredConfigPath, 'utf8');
	const id = config.match(/^tunnel:\s*("?)([^"\n]+)\1/m)?.[2];
	const credentialsFile = config.match(/^credentials-file:\s*(.+)$/m)?.[1]?.trim();
	if (!id) throw new Error(`Missing tunnel id in ${cloudflaredConfigPath}`);
	if (!credentialsFile) throw new Error(`Missing credentials-file in ${cloudflaredConfigPath}`);
	return { id, credentialsFile };
}

async function ensureCloudflareDns(hostname: string, domain: string, tunnel: TunnelState) {
	const target = `${tunnel.id}.cfargotunnel.com`;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;

	if (!apiToken) {
		const result = run('cloudflared', ['tunnel', 'route', 'dns', tunnel.id, hostname], {
			allowFailure: true,
			capture: true,
		});
		if (result.status !== 0) {
			console.warn(
				`Cloudflare DNS was not updated. Set CLOUDFLARE_API_TOKEN, or create CNAME ${hostname} -> ${target}.`,
			);
		}
		return;
	}

	const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? (await lookupCloudflareZoneId(apiToken, domain));
	await upsertCloudflareCname(apiToken, zoneId, hostname, target);
}

async function lookupCloudflareZoneId(apiToken: string, domain: string) {
	const zones = await cloudflareRequest<Array<{ id: string; name: string }>>(
		apiToken,
		`/zones?name=${encodeURIComponent(domain)}&status=active`,
	);
	const zone = zones.find(candidate => candidate.name === domain);
	if (!zone) throw new Error(`Could not find Cloudflare zone for ${domain}`);
	return zone.id;
}

async function upsertCloudflareCname(apiToken: string, zoneId: string, hostname: string, target: string) {
	const records = await cloudflareRequest<Array<{ id: string; type: string; name: string }>>(
		apiToken,
		`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
	);
	const incompatible = records.find(record => record.type !== 'CNAME');
	if (incompatible) {
		throw new Error(`Existing ${incompatible.type} record for ${hostname} blocks CNAME creation`);
	}

	const body = JSON.stringify({
		type: 'CNAME',
		name: hostname,
		content: target,
		ttl: 1,
		proxied: true,
	});
	const cname = records.find(record => record.type === 'CNAME');
	if (cname) {
		await cloudflareRequest(apiToken, `/zones/${zoneId}/dns_records/${cname.id}`, {
			body,
			method: 'PUT',
		});
	} else {
		await cloudflareRequest(apiToken, `/zones/${zoneId}/dns_records`, {
			body,
			method: 'POST',
		});
	}
}

async function cloudflareRequest<T>(apiToken: string, apiPath: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${apiToken}`);
	headers.set('content-type', 'application/json');
	const response = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
		...init,
		headers,
	});
	const body = (await response.json()) as {
		success?: boolean;
		errors?: Array<{ message?: string }>;
		result?: T;
	};
	if (!response.ok || !body.success) {
		const message = body.errors
			?.map(error => error.message)
			.filter(Boolean)
			.join('; ');
		throw new Error(`Cloudflare API request failed: ${message || response.statusText}`);
	}
	return body.result as T;
}

async function recreateCloudflaredRouter(tunnel: TunnelState) {
	await stopHostCloudflared();
	await stopHostRouter();
	run('container', ['delete', '--force', tunnel.containerName], { allowFailure: true });
	run('container', [
		'create',
		'--name',
		tunnel.containerName,
		'--mount',
		`type=bind,source=${stateDir},target=/etc/paas,readonly`,
		'--mount',
		`type=bind,source=${path.dirname(tunnel.credentialsFile)},target=/etc/cloudflared-host,readonly`,
		cloudflaredImage,
		'tunnel',
		'--config',
		`/etc/paas/${path.basename(tunnel.configPath)}`,
		'run',
	]);
	await startContainer(tunnel.containerName);
}

async function stopHostCloudflared() {
	const label = 'lol.stf.cloudflared';
	const plist = path.join(launchAgentsDir, `${label}.plist`);
	if (!existsSync(plist)) return;
	run('launchctl', ['bootout', `gui/${process.getuid?.()}`, plist], { allowFailure: true });
	run('launchctl', ['disable', `gui/${process.getuid?.()}/${label}`], { allowFailure: true });
}

async function stopHostRouter() {
	const label = 'lol.stf.repo-containers.router';
	const plist = path.join(launchAgentsDir, `${label}.plist`);
	if (!existsSync(plist)) return;
	run('launchctl', ['bootout', `gui/${process.getuid?.()}`, plist], { allowFailure: true });
	run('launchctl', ['disable', `gui/${process.getuid?.()}/${label}`], { allowFailure: true });
	run('trash', [plist], { allowFailure: true });
}

async function verifyApp(app: AppState, container: ContainerConfig) {
	if (!app.containerIp) throw new Error(`Missing container IP for ${app.name}`);
	run('curl', [
		'--fail',
		'--silent',
		'--show-error',
		'--noproxy',
		'*',
		`http://${app.containerIp}:${app.containerPort}${container.healthPath}`,
	]);
	const external = await fetchWithTimeout(`https://${app.hostname}`, { timeoutMs: 8000 });
	if (!external.ok) {
		console.warn(`External Cloudflare check failed for https://${app.hostname}: ${external.error}`);
	}
}

async function fetchWithTimeout(url: string, options: { headers?: Record<string, string>; timeoutMs: number }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await fetch(url, {
			headers: options.headers,
			signal: controller.signal,
		});
		return { ok: response.status < 500, error: `HTTP ${response.status}` };
	} catch (error) {
		return { ok: false, error: String(error) };
	} finally {
		clearTimeout(timer);
	}
}

async function installAppLaunchAgent(name: string) {
	const bun = which('bun') || process.execPath;
	if (!bun) throw new Error('bun is not installed');

	const label = `lol.stf.repo-containers.${name}`;
	const plistPath = path.join(launchAgentsDir, `${label}.plist`);
	const plist = plistDocument(label, [bun, scriptPath, 'start', '--name', name], {
		startInterval: 60,
		stdout: path.join(logsDir, `${name}.starter.stdout.log`),
		stderr: path.join(logsDir, `${name}.starter.stderr.log`),
	});
	await writeFile(plistPath, plist);
	run('launchctl', ['bootout', `gui/${process.getuid?.()}`, plistPath], { allowFailure: true });
	run('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, plistPath], { allowFailure: true });
	run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${label}`], { allowFailure: true });
}

function plistDocument(
	label: string,
	args: string[],
	options: {
		keepAlive?: boolean;
		startInterval?: number;
		stdout: string;
		stderr: string;
	},
) {
	const argXml = args.map(arg => `		<string>${escapeXml(arg)}</string>`).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${escapeXml(label)}</string>
	<key>ProgramArguments</key>
	<array>
${argXml}
	</array>
	<key>RunAtLoad</key>
	<true/>
${options.keepAlive ? '\t<key>KeepAlive</key>\n\t<true/>\n' : ''}${options.startInterval ? `\t<key>StartInterval</key>\n\t<integer>${options.startInterval}</integer>\n` : ''}	<key>WorkingDirectory</key>
	<string>${escapeXml(scriptDir)}</string>
	<key>StandardOutPath</key>
	<string>${escapeXml(options.stdout)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(options.stderr)}</string>
</dict>
</plist>
`;
}

async function readState(): Promise<State> {
	if (!existsSync(statePath)) return { apps: {}, tunnels: {} };
	let raw = await readFile(statePath, 'utf8');
	while (raw.endsWith('\u0000')) raw = raw.slice(0, -1);
	const parsed = JSON.parse(raw) as {
		apps?: Record<string, Partial<AppState>>;
		tunnels?: Record<string, TunnelState>;
	};
	const state: State = { apps: {}, tunnels: parsed.tunnels ?? {} };
	for (const [name, app] of Object.entries(parsed.apps ?? {})) {
		state.apps[name] = {
			...(app as AppState),
			dataDir: app.dataDir ?? path.join(appsDir, name, 'data'),
			domain: app.domain ?? hostnameDomain(app.hostname ?? defaultDomain),
			tunnelName: app.tunnelName ?? defaultTunnelName,
		};
	}
	return state;
}

async function writeState(state: State) {
	const tempPath = `${statePath}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
	await rename(tempPath, statePath);
}

function option(cli: Cli, key: string) {
	return cli.options.get(key)?.at(-1);
}

function numberOption(cli: Cli, key: string, fallback: number) {
	const value = option(cli, key);
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) throw new Error(`--${key} must be an integer`);
	return parsed;
}

function sanitizeName(value: string) {
	const name = value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!name) throw new Error(`Invalid app name: ${value}`);
	return name;
}

function appTunnelName(app: Pick<AppState, 'tunnelName'>) {
	return app.tunnelName || defaultTunnelName;
}

function tunnelConfigPath(tunnelName: string) {
	return path.join(
		stateDir,
		tunnelName === defaultTunnelName ? 'cloudflared-router.yml' : `cloudflared-router-${tunnelName}.yml`,
	);
}

function tunnelContainerName(tunnelName: string) {
	return tunnelName === defaultTunnelName ? 'paas-cloudflared' : `paas-cloudflared-${tunnelName}`;
}

function hostnameDomain(hostname: string) {
	const parts = hostname.split('.');
	return parts.length >= 2 ? parts.slice(-2).join('.') : defaultDomain;
}

function expandHome(value: string) {
	if (value === '~') return home;
	if (value.startsWith('~/')) return path.join(home, value.slice(2));
	return value;
}

function escapeXml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function run(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		capture?: boolean;
		allowFailure?: boolean;
		env?: Record<string, string>;
	} = {},
) {
	console.log(`$ ${[command, ...args].join(' ')}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		encoding: 'utf8',
		stdio: options.capture ? 'pipe' : 'inherit',
		maxBuffer: 1024 * 1024 * 50,
	});

	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}\n${result.stderr ?? ''}`);
	}

	return {
		status: result.status ?? 0,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}
