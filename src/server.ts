import { timingSafeEqual } from 'node:crypto';
import { repoConfig } from './repoConfig.ts';

type ServerOptions = {
	bearerKey: string;
	configuredRepos?: Record<string, unknown>;
	runUpdate: (repo: string) => Promise<void>;
};

export function createFetchHandler({
	bearerKey,
	configuredRepos = repoConfig,
	runUpdate,
}: ServerOptions): (request: Request) => Promise<Response> | Response {
	const activeUpdates = new Set<string>();

	return async request => {
		const url = new URL(request.url);

		if (url.pathname === '/') {
			return json({ ok: true });
		}

		const repo = repoFromUpdatePath(url.pathname);
		if (!repo) {
			return json({ error: 'Not found', ok: false }, 404);
		}

		if (request.method !== 'POST') {
			return json({ error: 'Use POST for updates', ok: false }, 405, { allow: 'POST' });
		}

		if (!isAuthorized(request, bearerKey)) {
			return json({ error: 'Unauthorized', ok: false }, 401, { 'www-authenticate': 'Bearer' });
		}

		if (!Object.hasOwn(configuredRepos, repo)) {
			return json({ error: `No repo config found for "${repo}"`, ok: false }, 404);
		}

		if (activeUpdates.has(repo)) {
			return json({ error: `Update already running for "${repo}"`, ok: false }, 409);
		}

		activeUpdates.add(repo);
		console.log(`[${new Date().toISOString()}] Updating ${repo}`);

		try {
			await runUpdate(repo);
			console.log(`[${new Date().toISOString()}] Updated ${repo}`);
			return json({ ok: true, repo });
		} catch (error) {
			console.error(`[${new Date().toISOString()}] Failed to update ${repo}`, error);
			return json({ error: errorMessage(error), ok: false, repo }, 500);
		} finally {
			activeUpdates.delete(repo);
		}
	};
}

function repoFromUpdatePath(pathname: string) {
	const match = pathname.match(/^\/update\/([^/]+)$/);
	if (!match?.[1]) return undefined;

	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
}

function isAuthorized(request: Request, bearerKey: string) {
	const authorization = request.headers.get('authorization');
	const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	return typeof token === 'string' && secureEqual(token, bearerKey);
}

function secureEqual(left: string, right: string) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return Response.json(body, {
		headers: {
			...headers,
			'cache-control': 'no-store',
		},
		status,
	});
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
