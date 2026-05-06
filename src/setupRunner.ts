import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const setupScriptPath = path.join(scriptDir, 'setupRepoContainer.ts');

export async function runSetupRepoContainer(repo: string) {
	const args = [setupScriptPath, 'deploy', '--repo', repo];
	console.log(`$ ${[process.execPath, ...args].join(' ')}`);

	const child = spawn(process.execPath, args, {
		stdio: 'inherit',
	});

	const status = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});

	if (status !== 0) {
		throw new Error(`setupRepoContainer failed for ${repo} with status ${status}`);
	}
}
