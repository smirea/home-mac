import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const setupScriptPath = path.join(scriptDir, 'setupRepoContainer.ts');

export async function runSetupRepoContainer(repo: string, writeLog: (chunk: string) => void) {
	const args = [setupScriptPath, 'deploy', '--repo', repo, '--defer-router-restart'];
	writeLog(`$ ${[process.execPath, ...args].join(' ')}\n`);

	const child = spawn(process.execPath, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout?.on('data', chunk => writeLog(String(chunk)));
	child.stderr?.on('data', chunk => writeLog(String(chunk)));

	const status = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});

	if (status !== 0) {
		throw new Error(`setupRepoContainer failed for ${repo} with status ${status}`);
	}

	writeLog('Cloudflare router restart deferred until after this response closes.\n');
	setTimeout(() => {
		const routerArgs = [setupScriptPath, 'refresh-router', '--name', repo];
		console.log(`$ ${[process.execPath, ...routerArgs].join(' ')}`);
		const router = spawn(process.execPath, routerArgs, {
			detached: true,
			stdio: 'ignore',
		});
		router.unref();
	}, 1000);
}
