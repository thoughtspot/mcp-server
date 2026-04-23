import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK_MARKER = "# thoughtspot-mcp-server-hook";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookSourcePath = join(repoRoot, ".githooks", "pre-commit");

function getHooksDirectory() {
	const result = spawnSync("git", ["rev-parse", "--git-path", "hooks"], {
		cwd: repoRoot,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		console.warn("[hooks] Skipping install because this is not a git checkout.");
		return null;
	}

	return resolve(repoRoot, result.stdout.trim());
}

function isRepoManagedHook(hookPath) {
	if (!existsSync(hookPath)) {
		return true;
	}

	return readFileSync(hookPath, "utf8").includes(HOOK_MARKER);
}

const hooksDirectory = getHooksDirectory();

if (!hooksDirectory || !existsSync(hookSourcePath)) {
	process.exit(0);
}

const hookTargetPath = join(hooksDirectory, "pre-commit");

if (!isRepoManagedHook(hookTargetPath)) {
	console.warn(
		`[hooks] Skipping install because ${hookTargetPath} is already managed locally.`,
	);
	process.exit(0);
}

mkdirSync(hooksDirectory, { recursive: true });
copyFileSync(hookSourcePath, hookTargetPath);
chmodSync(hookTargetPath, 0o755);

console.log(`[hooks] Installed pre-commit hook at ${hookTargetPath}`);
