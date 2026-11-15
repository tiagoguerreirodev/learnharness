import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { Configuration } from "electron-builder";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(value: string): Record<string, any>; dump(value: unknown): string };

function fixture(t: TestContext) {
	const projectDir = mkdtempSync(path.join(tmpdir(), "lh-packaging-"));
	t.after(() => rmSync(projectDir, { recursive: true, force: true }));
	mkdirSync(path.join(projectDir, "scripts"));
	for (const name of ["package.json", "electron-builder.cjs", "electron-builder.base.yml", "scripts/release-repository.cjs"]) {
		copyFileSync(path.join(root, name), path.join(projectDir, name));
	}
	symlinkSync(path.join(root, "node_modules"), path.join(projectDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	return projectDir;
}

function loadDefault(projectDir: string, identity?: string) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (["LH_RELEASE_REPOSITORY", "GITHUB_REPOSITORY"].includes(key) || key.toUpperCase().startsWith("GIT_")) delete env[key];
	}
	if (identity !== undefined) env.LH_RELEASE_REPOSITORY = identity;
	return spawnSync(process.execPath, ["-e", `
		const { Packager } = require("electron-builder");
		const packager = new Packager({ projectDir: process.argv[1], publish: "never" });
		packager.validateConfig().then(() => console.log("CONFIG_RESULT=" + JSON.stringify(packager.config)))
			.catch(error => { console.error(error.message); process.exitCode = 1; });
	`, projectDir], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
}

function effective(projectDir: string, identity: string): Configuration {
	const result = loadDefault(projectDir, identity);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.split("CONFIG_RESULT=")[1]!) as Configuration;
}

test("default nonpublishing packaging fails closed for unidentified archives and invalid overrides", t => {
	const projectDir = fixture(t);
	const missing = loadDefault(projectDir);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Cannot resolve.*LH_RELEASE_REPOSITORY/);
	const invalid = loadDefault(projectDir, "https://secret-token@github.com/owner/repo");
	assert.equal(invalid.status, 1);
	assert.match(invalid.stderr, /Invalid LH_RELEASE_REPOSITORY/);
	assert.doesNotMatch(invalid.stderr, /secret-token/);
	assert.deepEqual(effective(projectDir, "archive/explicit").publish,
		[{ provider: "github", owner: "archive", repo: "explicit", releaseType: "draft" }]);
});

test("default packaging rejects conflicting destinations in the base instead of merging them", t => {
	const projectDir = fixture(t);
	const filename = path.join(projectDir, "electron-builder.base.yml");
	const original = yaml.load(readFileSync(filename, "utf8"));
	for (const mutate of [
		(config: Record<string, any>) => { config.publish = [{ provider: "generic", url: "https://other.example" }]; },
		(config: Record<string, any>) => { config.win.publish = [{ provider: "github", owner: "other", repo: "destination" }]; },
		(config: Record<string, any>) => { config.mac.publish = "github"; },
		(config: Record<string, any>) => { config.linux.publish = null; },
	]) {
		const base = structuredClone(original);
		mutate(base);
		writeFileSync(filename, yaml.dump(base));
		const result = loadDefault(projectDir, "selected/repository");
		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stderr, /publish.*must be supplied only by the repository adapter/);
	}
});

test("base configuration cannot inherit alternate publish destinations", t => {
	const projectDir = fixture(t);
	const filename = path.join(projectDir, "electron-builder.base.yml");
	const base = yaml.load(readFileSync(filename, "utf8"));
	writeFileSync(path.join(projectDir, "parent.yml"), yaml.dump({ publish: [
		{ provider: "github", owner: "other", repo: "one" }, { provider: "generic", url: "https://other.example" },
	] }));
	writeFileSync(filename, yaml.dump({ ...base, extends: "./parent.yml" }));
	const result = loadDefault(projectDir, "selected/repository");
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stderr, /YAML base must not extend other configurations/);
});

test("Builder default loading selects exactly one resolved GitHub draft destination and preserves packaging policy", () => {
	const config = effective(root, "arbitrary-owner/learning-fork");
	assert.deepEqual(config.publish, [{ provider: "github", owner: "arbitrary-owner", repo: "learning-fork", releaseType: "draft" }]);
	assert.equal(config.appId, "com.learnharness.LearnHarness");
	assert.equal(config.productName, "LearnHarness");
	assert.equal(config.directories?.output, "dist");
	assert.equal(config.afterPack, "scripts/after-pack.cjs");
	assert.deepEqual(config.win?.target, [{ target: "nsis", arch: ["x64"] }]);
	assert.equal(config.win?.artifactName, "${productName}-${version}-${arch}-setup.${ext}");
	assert.equal(config.win?.signExecutable, false);
	assert.equal(config.win?.verifyUpdateCodeSignature, false);
	assert.equal(config.mac?.notarize, true);
	assert.deepEqual(config.nsis, { oneClick: true, perMachine: false });
	assert.ok(JSON.stringify(config.files).includes("node_modules/electron-updater/**/*"));
	assert.ok(JSON.stringify(config.extraResources).includes('"to":"server"'));
	assert.deepEqual(effective(root, "amosblomqvist/learnharness").publish,
		[{ provider: "github", owner: "amosblomqvist", repo: "learnharness", releaseType: "draft" }]);
});
