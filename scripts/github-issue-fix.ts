#!/usr/bin/env bun

import { fixIssue } from '../src/github.ts';

const parsed = parseIssue(Bun.argv.slice(2));

if (!parsed) {
	console.error('Usage: bun scripts/github-issue-fix.ts <github issue URL | owner/repo#123 | owner/repo 123>');
	process.exit(1);
}

await fixIssue(parsed);

function parseIssue(args: string[]) {
	const [target, issueArg] = args;
	if (!target) return undefined;

	if (issueArg) return parseRepoAndIssue(target, issueArg);

	return parseGithubIssueUrl(target) ?? parseRepoHash(target);
}

function parseGithubIssueUrl(target: string) {
	try {
		const url = new URL(target);
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
		if (!match) return undefined;
		return parseRepoAndIssue(`${match[1]}/${match[2]}`, match[3]);
	} catch {
		return undefined;
	}
}

function parseRepoHash(target: string) {
	const match = target.match(/^([^/]+\/[^#]+)#(\d+)$/);
	if (!match) return undefined;
	return parseRepoAndIssue(match[1], match[2]);
}

function parseRepoAndIssue(repoFullName: string, issue: string) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName) || !/^\d+$/.test(issue)) return undefined;
	return { repoFullName, issue };
}
