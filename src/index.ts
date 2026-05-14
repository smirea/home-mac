import env from './env.ts';
import { createFetchHandler } from './server.ts';
import { runSetupRepoContainer } from './setupRunner.ts';

if (env.UPDATE_BEARER_KEY.length === 0) {
	throw new Error('UPDATE_BEARER_KEY must not be empty');
}

const server = Bun.serve({
	fetch: createFetchHandler({
		bearerKey: env.UPDATE_BEARER_KEY,
		runUpdate: runSetupRepoContainer,
	}),
	hostname: '0.0.0.0',
	idleTimeout: 600,
	port: 3000,
});

console.log(`mac.stf.lol update server listening on http://${server.hostname}:${server.port}`);
