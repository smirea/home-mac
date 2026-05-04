import { spawn } from 'node:child_process';

export type RepoConfig = {
	subdomain: string;
	setup: () => Promise<void>;
	start: () => Promise<void>;
	stop: () => Promise<void>;
};

type NodeClientServerOptions = {
	subdomain: string;
	setupCommand?: string[];
	startCommand?: string[];
	stopCommand?: string[];
};

export function nodeClientServer({
	subdomain,
	setupCommand = ['bun', 'install'],
	startCommand = ['bun', 'dev'],
	stopCommand,
}: NodeClientServerOptions): RepoConfig {
	return {
		subdomain,
		setup: () => run(setupCommand),
		start: () => run(startCommand),
		stop: () => (stopCommand ? run(stopCommand) : Promise.resolve()),
	};
}

export const repoConfig: Record<string, RepoConfig> = {
	decideroo: nodeClientServer({
		subdomain: 'decideroo',
	}),
};

async function run(command: string[]) {
	const [executable, ...args] = command;
	if (!executable) throw new Error('Command must not be empty');

	const child = spawn(executable, args, {
		env: process.env,
		stdio: 'inherit',
	});

	const status = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	if (status !== 0) {
		throw new Error(`${command.join(' ')} failed with status ${status}`);
	}
}
