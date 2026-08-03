import { timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { repoConfig } from './repoConfig.ts';
import { createGithubMiddleware } from './github.ts';

type ServerOptions = {
	bearerKey: string;
	configuredRepos?: Record<string, unknown>;
	publicDir?: string;
	runUpdate: (repo: string, writeLog: (chunk: string) => void) => Promise<void>;
};

export function createFetchHandler({
	bearerKey,
	configuredRepos = repoConfig,
	publicDir,
	runUpdate,
}: ServerOptions): (request: Request) => Promise<Response> | Response {
	const activeUpdates = new Set<string>();

	return async req => {
		const url = new URL(req.url);

		if (url.pathname === '/') return json({ ok: true });

		const publicFile = await servePublicFile(req, url.pathname, publicDir);
		if (publicFile) return publicFile;

		if (req.method === 'POST' && url.pathname.startsWith('/git-webhook/')) {
			return createGithubMiddleware({ path: '/git-webhook/' })(req);
		}

		const repo = repoFromUpdatePath(url.pathname);
		if (!repo) return json({ error: 'Not found', ok: false }, 404);

		if (req.method !== 'POST') {
			return json({ error: 'Use POST for updates', ok: false }, 405, { allow: 'POST' });
		}

		if (!isAuthorized(req, bearerKey)) {
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

async function servePublicFile(request: Request, pathname: string, publicDir?: string) {
	if (!publicDir || (pathname !== '/public' && !pathname.startsWith('/public/'))) return undefined;
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return json({ error: 'Use GET or HEAD for public files', ok: false }, 405, {
			allow: 'GET, HEAD',
		});
	}
	if (pathname === '/public') return Response.redirect(new URL('/public/', request.url), 308);
	if (pathname === '/public/') return servePublicIndex(request, publicDir);

	let filename: string;
	try {
		filename = decodeURIComponent(pathname.slice('/public/'.length));
	} catch {
		return json({ error: 'Not found', ok: false }, 404);
	}

	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) {
		return json({ error: 'Not found', ok: false }, 404);
	}

	const file = Bun.file(path.join(publicDir, filename));
	if (!(await file.exists())) return json({ error: 'Not found', ok: false }, 404);

	return new Response(request.method === 'HEAD' ? null : file, {
		headers: {
			'cache-control': 'no-store',
			'content-length': String(file.size),
			'content-type': file.type || 'application/octet-stream',
		},
	});
}

async function servePublicIndex(request: Request, publicDir: string) {
	const entries = await readdir(publicDir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i.test(entry.name))
		.map(entry => entry.name)
		.sort((left, right) => left.localeCompare(right));
	const items = files
		.map(filename => `<li><a href="/public/${encodeURIComponent(filename)}">${escapeHtml(filename)}</a></li>`)
		.join('');
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Published HTML</title>
<style>
body{max-width:720px;margin:60px auto;padding:0 20px;background:#f7f6f2;color:#181a25;font:16px/1.5 ui-sans-serif,system-ui,sans-serif}
h1{font-size:clamp(32px,7vw,56px);letter-spacing:-.04em}ul{padding:0;list-style:none}li{margin:10px 0}
a{display:block;border:1px solid #dddce4;border-radius:10px;background:#fff;padding:14px 16px;color:#412773;font-weight:750;text-decoration:none;box-shadow:0 8px 24px rgba(39,30,63,.07)}a:hover{border-color:#9f88c5}
</style>
</head>
<body>
<h1>Published HTML</h1>
${items ? `<ul>${items}</ul>` : '<p>No HTML files are published.</p>'}
</body>
</html>`;

	return new Response(request.method === 'HEAD' ? null : html, {
		headers: {
			'cache-control': 'no-store',
			'content-length': String(Buffer.byteLength(html)),
			'content-type': 'text/html; charset=utf-8',
		},
	});
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

function streamUpdate(
	repo: string,
	activeUpdates: Set<string>,
	runUpdate: (repo: string, writeLog: (chunk: string) => void) => Promise<void>,
) {
	activeUpdates.add(repo);

	const encoder = new TextEncoder();
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (chunk: string) => {
				console.log(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);
				if (!closed) controller.enqueue(encoder.encode(chunk));
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
				if (!closed) {
					closed = true;
					controller.close();
				}
			}
		},
		cancel() {
			closed = true;
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
