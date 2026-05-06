import { timingSafeEqual } from 'node:crypto';
import { repoConfig } from './repoConfig.ts';

type ServerOptions = {
	bearerKey: string;
	configuredRepos?: Record<string, unknown>;
	runUpdate: (repo: string, writeLog: (chunk: string) => void) => Promise<void>;
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

		return streamUpdate(repo, activeUpdates, runUpdate);
	};
}

function streamUpdate(
	repo: string,
	activeUpdates: Set<string>,
	runUpdate: (repo: string, writeLog: (chunk: string) => void) => Promise<void>,
) {
	activeUpdates.add(repo);

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (chunk: string) => {
				console.log(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);
				controller.enqueue(encoder.encode(chunk));
			};

			write(`[${new Date().toISOString()}] Updating ${repo}\n`);

			try {
				await runUpdate(repo, write);
				write(`[${new Date().toISOString()}] Updated ${repo}\n`);
				write(`DEPLOY_OK repo=${repo}\n`);
			} catch (error) {
				const message = errorMessage(error);
				write(`[${new Date().toISOString()}] Failed to update ${repo}\n`);
				write(`${message}\n`);
				write(`DEPLOY_FAILED repo=${repo}\n`);
				console.error(error);
			} finally {
				activeUpdates.delete(repo);
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/plain; charset=utf-8',
		},
	});
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
