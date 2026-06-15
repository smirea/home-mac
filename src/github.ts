import path from 'path';
import fsp from 'fs/promises';
import chalk from 'chalk';
import { execSync, type ExecSyncOptions } from 'child_process';
import { createWebMiddleware, Webhooks } from '@octokit/webhooks';
import env from './env';

const workdirRoot = path.join(__dirname, '..', 'workdir');
const codexCanonicalDir = path.join((process.env as any).HOME!, '.codex');

const whitelist = new Set(['decideroo', 'hanabi', 'hegemony']);

export function createGithubMiddleware(opts: { path: string }) {
	const webhooks = new Webhooks({ secret: env.UPDATE_BEARER_KEY });

	webhooks.onError(error => {
		console.error('webhook error:', error.message);
	});

	webhooks.on(['issues', 'issue_comment'], async event => {
		const { issue, repository, sender } = event.payload;

		return; // disabled checkpoint

		if (!repository.full_name.startsWith('smirea/')) throw new Error('oh noes');
		if (!whitelist.has(repository.name)) return console.warn(chalk.yellow('not whitelisted:', repository.full_name));
		if (sender.login === 'smirea-ai') throw new Error('nope');

		const collaborators = await getCollaborators(repository.full_name);
		if (!collaborators.find(x => x.login === sender.login)) throw new Error('nuh huh');
		if (!collaborators.find(x => x.login === 'smirea-ai')) throw new Error('clanker not found');

		switch (event.name) {
			case 'issues':
				await fixIssue({
					repoFullName: repository.full_name,
					issue: String(issue.number),
				});
				break;
			default:
				console.error('unhandled:', event.name);
		}
	});

	return createWebMiddleware(webhooks, opts);
}

async function getCollaborators(repoFullName: string) {
	const json = await Bun.$`gh api repos/${repoFullName}/collaborators --paginate`.json();
	return json as Array<{ login: string; permissions: Record<string, boolean> }>;
}

async function fixIssue({ repoFullName, issue }: { repoFullName: string; issue: string }) {
	const workdir = path.join(workdirRoot, repoFullName.split('/').pop()!);
	const repoDir = path.join(workdir, issue);
	// share 1 codex home to have shared memory for all issues
	const codexHome = path.join(workdir, 'codex');

	if (!repoFullName.startsWith('smirea/')) throw new Error('oh noes');

	await fsp.mkdir(workdir, { recursive: true });

	await fsp.rm(repoDir, { recursive: true, force: true });
	cmd(`git clone git@github.com:${repoFullName}.git '${repoDir}'`);
	cmd.setCWD(repoDir);

	const gitConfig = {
		'user.name': 'gpt-5.5_codex',
		'user.email': 'me+ai@stefanmirea.com',
		'core.sshCommand': 'ssh -i ~/.ssh/id_rsa_ai -o IdentitiesOnly=yes',
		'alias.ci': 'commit --trailer "Co-Authored-By: stefan <steven.mirea@gmail.com>"',
	};
	for (const [k, v] of Object.entries(gitConfig)) cmd(`git config set --local '${k}' '${v}'`);

	cmd(`bun install`);
	cmd(`env-manager down`);
	cmd(`git checkout -b issue/${issue}`);

	if (!(await fsp.exists(codexHome))) await fsp.cp(codexCanonicalDir, codexHome, { recursive: true });
	const agentsFile = path.join(codexHome, 'AGENTS.md');
	await fsp.rm(agentsFile, { force: true });
	await fsp.writeFile(agentsFile, AGENTS_MD);
	const message = `You are responsible for issue ${repoFullName}#${issue} on github. You are already in that repo and it should already be fully set up.`;

	cmd.updateEnv({
		CODEX_HOME: codexHome,
		GH_TOKEN: (await Bun.$`gh auth token --user smirea-ai`.text()).trim(),
	});

	cmd(`codex exec -s workspace-write -c 'sandbox_workspace_write.network_access=true' '${message}'`);
}

const cmd = (() => {
	let cwd = process.cwd();
	let env = process.env;

	return Object.assign(
		function cmd(command: string, options?: ExecSyncOptions) {
			console.log(
				// chalk.gray(`[${formatDate(new Date(), 'HH:mm:ss')}]`),
				chalk.bold('run cmd:'),
				chalk.green(command),
			);
			return execSync(command, { stdio: 'inherit', env, cwd, ...options });
		},
		{
			setCWD: (target: string) => {
				cwd = target;
			},
			setEnv: (target: Record<string, any>) => {
				env = target;
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
1. React to the issue with "eyes" to show you started working (use github cli \`gh api --method POST repos/{owner}/{repo}/issues/{issue_number}/reactions -f content='eyes'\`)
2. Read the full issue with all attachments and comments
3. Verify the issue makes sense: if it's a bug, reproduce it, if it's a feature, analyze the codebase and the history to understand the context and prior art in this repo
3.1. if it's a bug and you can't reproduce it, post a comment with steps you took and the outcome, attach images if helpful
3.2. if it's a feature and it's confusing or does not make sense, reply with a comment for clarifications and short specific details on why
4. implement the request and validate it's working by running the application and interacting with the request
5. Once completed and validate commit your changes with \`git ci\` and mention "Fixes #issueNumber" in the commit message such that the branch is linked to the issue automatically.
6. Create a pull request for the branch, wait for the build to complete, fix if needed and merge once all checks are green (or if there are no checks).

# Resources
- [github REST api](https://docs.github.com/en/rest)
`;
