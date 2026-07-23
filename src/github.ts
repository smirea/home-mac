import path from 'path';
import fsp from 'fs/promises';
import chalk from 'chalk';
import { createWebMiddleware, Webhooks } from '@octokit/webhooks';
import env from './env';
import { createInterface } from 'readline';
import { Readable } from 'stream';

const workdirRoot = path.join(__dirname, '..', 'workdir');
const threadsCachePath = path.join(workdirRoot, 'threads.json');
const codexCanonicalDir = path.join(Bun.env.HOME!, '.codex');
const commandPath = [
	path.dirname(process.execPath),
	path.join(Bun.env.HOME!, 'bin'),
	'/opt/homebrew/bin',
	'/opt/homebrew/sbin',
	'/usr/local/bin',
	process.env.PATH,
]
	.filter(Boolean)
	.join(':');

process.env.PATH = commandPath;

const whitelist = new Set(['decideroo', 'hanabi', 'hegemony', 'ios-voice-memo', 'phantom-ink']);

// setTimeout(() => fixIssue({ repoFullName: 'smirea/phantom-ink', issue: '1' }), 10);

type Thread = { readonly date: string; readonly id?: string; readonly runningProcess?: Bun.Subprocess };
const threads = {
	data: ((await fsp.exists(threadsCachePath)) ? await Bun.file(threadsCachePath).json() : {}) as Record<string, Thread>,
	get(dir: string) {
		threads.data[dir] ||= { date: new Date().toISOString() };
		return Object.assign(Object.create(threads.data[dir]) as Thread, {
			update(diff: Partial<Thread>) {
				Object.assign(threads.data[dir], diff);
				const cleaned = Object.fromEntries(
					Object.entries(threads.data).map(([k, { runningProcess: _, ...rest }]) => [k, rest]),
				);
				void fsp.writeFile(threadsCachePath, JSON.stringify(cleaned, null, 4));
				return threads.get(dir);
			},
		});
	},
};

export function createGithubMiddleware(opts: { path: string }) {
	const webhooks = new Webhooks({ secret: env.UPDATE_BEARER_KEY });

	webhooks.onError(error => {
		console.error('webhook error:', error.message);
	});

	webhooks.on(['issues.opened', 'issues.edited', 'issue_comment'], async event => {
		const { issue, repository, sender } = event.payload;
		const action = 'action' in event.payload ? event.payload.action : 'unknown';
		const target = `${repository.full_name}#${issue.number}`;

		console.log(chalk.bold('github webhook:'), event.name, action, target, chalk.bold('sender:'), sender.login);

		if (!repository.full_name.startsWith('smirea/')) throw new Error('oh noes');
		if (!whitelist.has(repository.name)) {
			console.warn(chalk.yellow('github webhook skipped: not whitelisted'), repository.full_name);
			return;
		}
		if (event.name === 'issue_comment' && !['created', 'edited'].includes(action)) {
			console.warn(chalk.yellow('github webhook skipped: unsupported comment action'), action, target);
			return;
		}
		if (event.name === 'issue_comment' && sender.login === 'smirea-ai') {
			console.warn(chalk.yellow('github webhook skipped: smirea-ai comment loop guard'), target);
			return;
		}

		const collaborators = await getCollaborators(repository.full_name);
		if (!collaborators.find(x => x.login === sender.login)) throw new Error('nuh huh');
		if (!collaborators.find(x => x.login === 'smirea-ai')) throw new Error('clanker not found');

		switch (event.name) {
			case 'issue_comment':
			case 'issues':
				await fixIssue({
					repoFullName: repository.full_name,
					issue: String(issue.number),
				});
				break;
			default:
				console.error('unhandled:', (event as any).name);
		}
	});

	return createWebMiddleware(webhooks, opts);
}

async function getCollaborators(repoFullName: string) {
	const json = await Bun.$`gh api repos/${repoFullName}/collaborators --paginate`.json();
	return json as Array<{ login: string; permissions: Record<string, boolean> }>;
}

type CodexExecEvent =
	| { type: 'thread.started'; thread_id: string }
	| { type: 'turn.started' }
	| {
			type: 'turn.completed';
			usage: {
				input_tokens: number;
				cached_input_tokens: number;
				output_tokens: number;
				reasoning_output_tokens: number;
			};
	  }
	| { type: 'turn.failed'; error?: unknown }
	| { type: 'error'; message?: string; error?: unknown }
	| {
			type: 'item.completed';
			item?: {
				id?: string;
				type?: string;
				text?: string;
				[key: string]: unknown;
			};
	  }
	| {
			type: 'item.started';
			item: { id: string; type: string; [k: string]: unknown };
	  };

export async function fixIssue({ repoFullName, issue }: { repoFullName: string; issue: string }) {
	const workdir = path.join(workdirRoot, repoFullName.split('/').pop()!);
	const repoDir = path.join(workdir, issue);
	// share 1 codex home to have shared memory for all issues
	const codexHome = path.join(workdir, 'codex');

	if (!repoFullName.startsWith('smirea/')) throw new Error('oh noes');

	const thread = threads.get(repoDir);
	thread.runningProcess?.kill();

	await fsp.mkdir(workdir, { recursive: true });

	if (!thread.id || !(await fsp.exists(repoDir)) || new Date(thread.date).getTime() < Date.now() - 24 * 3600e3) {
		await fsp.rm(repoDir, { recursive: true, force: true });
		await cmd(`git clone git@github.com:${repoFullName}.git '${repoDir}'`);
	}

	cmd.setCWD(repoDir);

	const gitConfig = {
		'user.name': 'AI Stefan (gpt-5.5_codex)',
		'user.email': 'me+ai@stefanmirea.com',
		'core.sshCommand': 'ssh -i ~/.ssh/id_rsa_ai -o IdentitiesOnly=yes',
		'alias.ci': 'commit --trailer "Co-Authored-By: stefan <steven.mirea@gmail.com>"',
	};
	for (const [k, v] of Object.entries(gitConfig)) await cmd(`git config set --local '${k}' '${v}'`);
	const branchName = `issue-${issue}`;
	if ((await cmd('git branch --show-current')) !== branchName) {
		await cmd(
			`if git show-ref --verify --quiet refs/heads/${branchName}; then git checkout ${branchName}; else git checkout -b ${branchName}; fi`,
		);
	}

	if (!(await fsp.exists(codexHome))) await fsp.cp(codexCanonicalDir, codexHome, { recursive: true });
	const agentsFile = path.join(codexHome, 'AGENTS.md');
	await fsp.rm(agentsFile, { force: true });
	await fsp.writeFile(agentsFile, AGENTS_MD);

	await cmd(`${JSON.stringify(process.execPath)} install`);
	const envPath = path.join(repoDir, '.env');
	if ((await fsp.exists(envPath)) && (await Bun.file(envPath).text()).includes('env-manager'))
		await cmd(`env-manager down`);

	const proc = Bun.spawn(
		[
			'codex',
			'exec',
			'-s',
			'danger-full-access',
			'--cd',
			repoDir,
			...(thread.id ? ['resume', thread.id] : []),
			'--json',
			'-c',
			'sandbox_workspace_write.network_access=true',
			thread.id
				? `You are responsible for issue ${repoFullName}#${issue} on github, you are in the middle of working on that issue so resume`
				: `You are responsible for issue ${repoFullName}#${issue} on github. You are already in that repo and it should already be fully set up.`,
		],
		{
			stdout: 'pipe',
			stdin: 'ignore',
			stderr: 'inherit',
			cwd: repoDir,
			env: {
				...(Bun.env as any),
				PATH: commandPath,
				CODEX_HOME: codexHome,
				GH_TOKEN: (await Bun.$`gh auth token --user smirea-ai`.text()).trim(),
			},
		},
	);

	thread.update({ runningProcess: proc });

	const lines = createInterface({
		input: Readable.fromWeb(proc.stdout as any),
		crlfDelay: Infinity,
	});

	for await (const line of lines) {
		if (!line.trim()) continue;
		if (!thread.runningProcess) break;

		const event: CodexExecEvent = JSON.parse(line);
		switch (event.type) {
			case 'thread.started':
				thread.update({ id: event.thread_id });
				console.log(chalk.bold('repo:'), repoDir, chalk.bold('thread:'), event.thread_id);
				break;
			case 'turn.completed':
				// running[repoDir]
				break;
		}
	}

	const code = await proc.exited;
	if (code !== 0) console.error('codex failed with code', code);
	thread.update({ runningProcess: undefined });
	console.log(chalk.bold('repo:'), repoDir, chalk.bold('thread:'), chalk.green('done'));
}

const cmd = (() => {
	let cwd = process.cwd();
	let env: Record<string, any> = { ...process.env, PATH: commandPath };

	return Object.assign(
		async function cmd(command: string, options: { cwd?: string; env?: Record<string, any> } = {}) {
			const d = new Date();
			console.log(
				chalk.gray(
					`${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')} |`,
				),
				// chalk.bold('$>'),
				chalk.green(command),
			);
			const proc = Bun.spawn(['zsh', '-lc', command], {
				cwd: options.cwd ?? cwd,
				env: { ...(env as any), ...options.env },
				stdin: 'inherit',
				stdout: 'pipe',
				stderr: 'inherit',
			});

			let stdout = '';
			const decoder = new TextDecoder();

			for await (const chunk of proc.stdout) {
				Bun.stdout.write(chunk);
				stdout += decoder.decode(chunk, { stream: true });
			}
			stdout += decoder.decode();
			const code = await proc.exited;
			if (code !== 0) throw new Error(`${command} exited ${code}`);
			return stdout.trim();
		},
		{
			setCWD: (target: string) => {
				cwd = target;
			},
			setEnv: (target: Record<string, any>) => {
				env = { ...target, PATH: target.PATH ?? commandPath };
			},
			updateEnv: (diff: Record<string, any>) => {
				env = { ...env, ...diff };
			},
		},
	);
})();

const AGENTS_MD = `
You are an experienced solo developer working on hobby projects, you prefer simplicity and hate boilerplate.

Avoid writing code comments unless they are really valuable. Really valuable code commends document decisions, unexpected behavior or give additional context for the particular decision. Comments that have no value: explaining code, headers, decorative breaks, could easily be inferred by reading the code

Once you've fully addressed the request, you should commit to git.
When comitting code always use the \`git ci\` command instead of \`git commit\` (git ci is an alias to \`git commit -m ...\` that sets tracers, it works exactly as the vanilla "git commit" command). use the first line of the message for the header and add decisions, reasons, details etc beneath just like git standard commit. There are usually pre-commit hooks that run, address their feedback if they fail. After success, push. NEVER commit secrets or api keys into git, if you find yourself in a situation that does this, rethink your assumptions.

Never write trivial tests, it's fine if there are no tests for a feature

there is a \`env-manager\` utility that can be used to load and save environment variables automatically, and even create environemt variables for your project. This project should already be fully set up

# Working on issues: always follow this process. You must complete each step before moving onto the next
1. Read the full issue with all attachments and all comments
1.1. If there are comments, react with "eyes" on every comment to acknowledge them also
2. React to the issue with "eyes" to show you started working (use github cli \`gh api --method POST repos/{owner}/{repo}/issues/{issue_number}/reactions -f content='eyes'\`)
3. Verify the issue makes sense: if it's a bug, reproduce it, if it's a feature, analyze the codebase and the history to understand the context and prior art in this repo
3.1. if it's a bug and you can't reproduce it, post a comment with steps you took and the outcome, attach images if helpful
3.2. if it's a feature and it's confusing or does not make sense, reply with a comment for clarifications and short specific details on why
4. implement the request and validate it's working by running the application and interacting with the request
4.1. If the feature has checkboxes as todo-list, consider creating 1 commit per checkbox and ticking each checkbox as it's completed
5. Once completed and validate commit your changes with \`git ci\` and mention "Fixes #issueNumber" in the commit message such that the branch is linked to the issue automatically.
5.1. Post a messge on the original issue thread with brief overview of the solution and include one or more screenshots of the relevant changes (for UI/UX changes)
6. Create a pull request for the branch, wait for the build to complete, fix if needed and merge via rebase once all checks are green (or if there are no checks). Once pull request is merged, delete the remote branch

# Resources
- [github REST api](https://docs.github.com/en/rest)
`;
