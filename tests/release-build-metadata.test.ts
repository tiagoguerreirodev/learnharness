import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function fixture(t: TestContext) {
	const projectDir = mkdtempSync(path.join(tmpdir(), "lh-renderer-metadata-"));
	t.after(() => rmSync(projectDir, { recursive: true, force: true }));
	mkdirSync(path.join(projectDir, "scripts"));
	mkdirSync(path.join(projectDir, "lib"));
	for (const name of ["package.json", "next.config.ts", "scripts/release-repository.cjs", "lib/notes-import-limits.ts"]) {
		copyFileSync(path.join(root, name), path.join(projectDir, name));
	}
	symlinkSync(path.join(root, "node_modules"), path.join(projectDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	return projectDir;
}

function loadMetadata(projectDir: string, identity: Record<string, string> = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (["LH_RELEASE_REPOSITORY", "GITHUB_REPOSITORY", "LH_RELEASE_REPOSITORY_URL"].includes(key) || key.toUpperCase().startsWith("GIT_")) delete env[key];
	}
	return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", `
		import config from ${JSON.stringify(pathToFileURL(path.join(projectDir, "next.config.ts")).href)};
		console.log(JSON.stringify(config.env));
	`], { cwd: projectDir, env: { ...env, ...identity }, encoding: "utf8", timeout: 30_000 });
}

test("renderer build exposes the selected fork's normalized public URL without changing version or homepage", t => {
	const result = loadMetadata(fixture(t), { LH_RELEASE_REPOSITORY: "Arbitrary-Owner/Learning-Fork", GITHUB_REPOSITORY: "other/workflow" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		LH_VERSION: pkg.version,
		LH_HOMEPAGE: pkg.homepage,
		LH_RELEASE_REPOSITORY_URL: "https://github.com/arbitrary-owner/learning-fork",
	});
});

test("Actions and upstream builds expose their own repository, never the attribution homepage as a fallback", t => {
	const projectDir = fixture(t);
	for (const [identity, url] of [
		[{ GITHUB_REPOSITORY: "Workflow-Owner/Another-Fork" }, "https://github.com/workflow-owner/another-fork"],
		[{ LH_RELEASE_REPOSITORY: "amosblomqvist/learnharness" }, "https://github.com/amosblomqvist/learnharness"],
	] as const) {
		const result = loadMetadata(projectDir, identity);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage, LH_RELEASE_REPOSITORY_URL: url,
		});
	}
});

test("an unidentified web archive succeeds with empty repository metadata despite stale public URL input", t => {
	const result = loadMetadata(fixture(t), { LH_RELEASE_REPOSITORY_URL: "https://github.com/stale/repository" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage, LH_RELEASE_REPOSITORY_URL: "",
	});
});

test("web metadata rejects invalid first-applicable identity without leaking it or falling through", t => {
	const result = loadMetadata(fixture(t), {
		LH_RELEASE_REPOSITORY: "https://secret-token@github.com/owner/repo", GITHUB_REPOSITORY: "valid/fallback",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Invalid LH_RELEASE_REPOSITORY: expected a GitHub owner\/repo\./);
	assert.doesNotMatch(result.stderr + result.stdout, /secret-token/);
});

test("origin-based renderer metadata contains only public normalized identity, not build credentials", t => {
	const projectDir = fixture(t);
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = path.join(projectDir, "absent-git-config");
	for (const args of [
		["init", "--quiet"],
		["config", "--local", "remote.origin.url", "https://build-user:origin-secret@github.com/Origin-Owner/Source-Fork.git"],
	]) execFileSync("git", ["-C", projectDir, ...args], { env, stdio: "pipe" });
	const result = loadMetadata(projectDir, { GITHUB_TOKEN: "not-public-build-token" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage,
		LH_RELEASE_REPOSITORY_URL: "https://github.com/origin-owner/source-fork",
	});
	assert.doesNotMatch(result.stdout + result.stderr, /origin-secret|build-user|not-public-build-token/);
});
