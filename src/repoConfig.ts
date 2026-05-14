import { spawn } from 'node:child_process';

export type RepoConfig = {
	subdomain: string;
	container: ContainerConfig;
	setup: () => Promise<void>;
	start: () => Promise<void>;
	stop: () => Promise<void>;
};

export type ContainerConfig =
	| {
			type: 'node-client-server';
			healthPath: string;
	  }
	| {
			type: 'bun-server';
			healthPath: string;
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
		container: {
			type: 'node-client-server',
			healthPath: '/api/status',
		},
		setup: () => run(setupCommand),
		start: () => run(startCommand),
		stop: () => (stopCommand ? run(stopCommand) : Promise.resolve()),
	};
}

export function bunServer({ subdomain }: { subdomain: string }): RepoConfig {
	return {
		subdomain,
		container: {
			type: 'bun-server',
			healthPath: '/',
		},
		setup: () => run(['bun', 'install']),
		start: () => run(['bun', 'src/index.ts', '--open', 'false']),
		stop: () => Promise.resolve(),
	};
}

export const repoConfig: Record<string, RepoConfig> = {
	decideroo: nodeClientServer({
		subdomain: 'decideroo',
	}),
	'travel-surfing-planner': bunServer({
		subdomain: 'surf-in-september',
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
