#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = homedir();
const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const logsDir = path.join(home, 'Library', 'Logs', 'mac.stf.lol');
const label = 'lol.stf.mac';
const watchdogLabel = `${label}.watchdog`;
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const watchdogPlistPath = path.join(launchAgentsDir, `${watchdogLabel}.plist`);
const bunPath = which('bun');
const uid = process.getuid?.();

if (!bunPath) {
	throw new Error('bun is not installed');
}

if (uid === undefined) {
	throw new Error('Cannot install a user LaunchAgent without a POSIX uid');
}

if (!existsSync(path.join(repoDir, '.env.local'))) {
	throw new Error(`Missing ${path.join(repoDir, '.env.local')}; run env-manager down before installing`);
}

await mkdir(launchAgentsDir, { recursive: true });
await mkdir(logsDir, { recursive: true });

const serverCommand = [
	`cd ${shellQuote(repoDir)}`,
	'if command -v env-manager >/dev/null 2>&1; then env-manager down || true; fi',
	`exec ${shellQuote(bunPath)} src/index.ts`,
].join(' && ');
const watchdogCommand = [
	'while true; do',
	'/usr/bin/curl --fail --silent --max-time 5 http://127.0.0.1:3000/ >/dev/null || {',
	`echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restarting ${label}";`,
	`launchctl kickstart -k gui/${uid}/${label};`,
	'};',
	'sleep 30;',
	'done',
].join(' ');

await writeFile(
	plistPath,
	plistDocument(label, ['/bin/zsh', '-lc', serverCommand], {
		keepAlive: true,
		stderr: path.join(logsDir, 'server.stderr.log'),
		stdout: path.join(logsDir, 'server.stdout.log'),
		workingDirectory: repoDir,
	}),
);
await writeFile(
	watchdogPlistPath,
	plistDocument(watchdogLabel, ['/bin/zsh', '-lc', watchdogCommand], {
		keepAlive: true,
		stderr: path.join(logsDir, 'watchdog.stderr.log'),
		stdout: path.join(logsDir, 'watchdog.stdout.log'),
		workingDirectory: repoDir,
	}),
);

run('launchctl', ['bootout', `gui/${uid}`, watchdogPlistPath], { allowFailure: true });
run('launchctl', ['bootout', `gui/${uid}`, plistPath], { allowFailure: true });
run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
run('launchctl', ['bootstrap', `gui/${uid}`, watchdogPlistPath]);
run('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
run('launchctl', ['kickstart', '-k', `gui/${uid}/${watchdogLabel}`]);

console.log(`Installed ${label} at ${plistPath}`);
console.log(`Installed ${watchdogLabel} at ${watchdogPlistPath}`);

function plistDocument(
	plistLabel: string,
	args: string[],
	options: {
		keepAlive: boolean;
		stderr: string;
		stdout: string;
		startInterval?: number;
		workingDirectory: string;
	},
) {
	const argXml = args.map(arg => `		<string>${escapeXml(arg)}</string>`).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${escapeXml(plistLabel)}</string>
	<key>ProgramArguments</key>
	<array>
${argXml}
	</array>
	<key>RunAtLoad</key>
	<true/>
${options.keepAlive ? '\t<key>KeepAlive</key>\n\t<true/>\n' : ''}${options.startInterval ? `\t<key>StartInterval</key>\n\t<integer>${options.startInterval}</integer>\n` : ''}	<key>WorkingDirectory</key>
	<string>${escapeXml(options.workingDirectory)}</string>
	<key>StandardOutPath</key>
	<string>${escapeXml(options.stdout)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(options.stderr)}</string>
</dict>
</plist>
`;
}

function which(command: string) {
	const result = spawnSync('which', [command], { encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim() : '';
}

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}) {
	console.log(`$ ${[command, ...args].join(' ')}`);
	const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit' });
	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
	}
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeXml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}
