import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK_MARKER = "# thoughtspot-mcp-server-hook";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookSourcePath = resolve(repoRoot, ".githooks", "pre-commit");

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
	try {
		if (!existsSync(hookPath)) {
			return true;
		}

		return readFileSync(hookPath, "utf8").includes(HOOK_MARKER);
	} catch {
		console.warn(
			`[hooks] Skipping install because ${hookPath} could not be inspected safely.`,
		);
		return false;
	}
}

if (process.env.CI) {
	console.log("[hooks] Skipping install in CI.");
	process.exit(0);
}

const hooksDirectory = getHooksDirectory();

if (!hooksDirectory || !existsSync(hookSourcePath)) {
	process.exit(0);
}

const hookTargetPath = resolve(hooksDirectory, "pre-commit");

if (hookSourcePath === hookTargetPath) {
	console.log("[hooks] Skipping install because git already uses the shared hook path.");
	process.exit(0);
}

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
