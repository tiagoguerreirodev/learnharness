import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

function git(projectDir: string, ...args: string[]) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.toUpperCase().startsWith("GIT_")) delete env[key];
	}
	return execFileSync("git", ["-C", projectDir, ...args], {
		env: { ...env, GIT_CONFIG_GLOBAL: path.join(projectDir, ".fixture-no-global-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
		encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
import { resolveReleaseRepository } from "../scripts/release-repository.cjs";

test("linked worktrees resolve their own project origin despite inherited Git context", () => {
	const root = mkdtempSync(path.join(tmpdir(), "lh-worktree-"));
	try {
		const checkout = path.join(root, "checkout");
		const linked = path.join(root, "linked");
		mkdirSync(checkout);
		git(checkout, "init");
		git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
		git(checkout, "remote", "add", "origin", "git@github.com:worktree-owner/learning-fork.git");
		git(checkout, "worktree", "add", "-b", "fixture-linked", linked);
		assert.deepEqual(resolveReleaseRepository({ projectDir: linked, env: {
			GIT_DIR: path.join(root, "unrelated.git"), GIT_WORK_TREE: root,
			GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "https://github.com/unrelated/injected",
		} }), { owner: "worktree-owner", repo: "learning-fork", url: "https://github.com/worktree-owner/learning-fork" });
		git(checkout, "config", "extensions.worktreeConfig", "true");
		git(linked, "config", "--worktree", "remote.origin.url", "https://github.com/worktree-only/selected-fork.git");
		assert.equal(resolveReleaseRepository({ projectDir: linked, env: {} })?.url, "https://github.com/worktree-only/selected-fork");
		git(linked, "config", "--worktree", "remote.origin.url", "https://secret-token@invalid.example/owner/repo");
		assert.throws(() => resolveReleaseRepository({ projectDir: linked, env: {} }),
			{ message: "Invalid application Git origin: expected a GitHub owner/repo." });
		git(linked, "config", "--worktree", "--unset", "remote.origin.url");
		assert.equal(resolveReleaseRepository({ projectDir: linked, env: {} })?.url, "https://github.com/worktree-owner/learning-fork");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("origin credentials never leave the resolver and malformed origins fail without falling back", () => {
	const projectDir = mkdtempSync(path.join(tmpdir(), "lh-credentials-"));
	try {
		git(projectDir, "init");
		git(projectDir, "remote", "add", "origin", "https://private-user:secret-token@github.com/Owner/Fork.git");
		assert.deepEqual(resolveReleaseRepository({ projectDir, env: {} }), {
			owner: "owner", repo: "fork", url: "https://github.com/owner/fork",
		});
		git(projectDir, "remote", "add", "upstream", "https://github.com/amosblomqvist/learnharness.git");
		for (const origin of ["https://private-user:secret-token@github.com.evil.test/owner/repo.git", "https://github.com/owner/repo?token=secret-token",
			"https://github.com/owner/repo/extra", "https://gitlab.com/owner/repo.git", "file:///private/secret-token", "https://github.com/owner/repo "]) {
			git(projectDir, "remote", "set-url", "origin", origin);
			assert.throws(() => resolveReleaseRepository({ projectDir, env: {}, required: false }),
				{ message: "Invalid application Git origin: expected a GitHub owner/repo." });
		}
	} finally { rmSync(projectDir, { recursive: true, force: true }); }
});

test("missing application identity is optional only for web consumers, never inherited by archives", () => {
	const root = mkdtempSync(path.join(tmpdir(), "lh-archive-"));
	try {
		const archive = path.join(root, "archive");
		mkdirSync(archive);
		const missing = () => {
			assert.equal(resolveReleaseRepository({ projectDir: archive, env: {}, required: false }), null);
			assert.throws(() => resolveReleaseRepository({ projectDir: archive, env: {} }), /Cannot resolve.*LH_RELEASE_REPOSITORY/);
		};
		missing();
		git(root, "init");
		git(root, "remote", "add", "origin", "https://github.com/unrelated/parent.git");
		missing();
		git(archive, "init");
		git(archive, "remote", "add", "upstream", "https://github.com/amosblomqvist/learnharness.git");
		missing();
		git(archive, "remote", "add", "origin", "https://github.com/local/project.git");
		assert.equal(resolveReleaseRepository({ projectDir: archive, env: { PATH: path.join(root, "no-git") }, required: false }), null);
		assert.throws(() => resolveReleaseRepository({ projectDir: archive, env: { PATH: path.join(root, "no-git") } }),
			/Cannot resolve.*LH_RELEASE_REPOSITORY/);
		assert.equal(resolveReleaseRepository({ projectDir: archive, env: { LH_RELEASE_REPOSITORY: "archive/explicit" } })?.url,
			"https://github.com/archive/explicit");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("application origin supports HTTPS and SSH without overriding explicit or Actions identity", () => {
	const projectDir = mkdtempSync(path.join(tmpdir(), "lh-repository-"));
	try {
		git(projectDir, "init");
		git(projectDir, "remote", "add", "origin", "https://github.com/fork-owner/arbitrary-fork.git");
		for (const origin of ["https://github.com/fork-owner/arbitrary-fork.git", "git@github.com:fork-owner/arbitrary-fork.git",
			"ssh://git@github.com/fork-owner/arbitrary-fork.git", "https://github.com/fork-owner/arbitrary-fork"]) {
			git(projectDir, "remote", "set-url", "origin", origin);
			assert.deepEqual(resolveReleaseRepository({ projectDir, env: {} }), {
				owner: "fork-owner", repo: "arbitrary-fork", url: "https://github.com/fork-owner/arbitrary-fork",
			});
		}
		assert.equal(resolveReleaseRepository({ projectDir, env: { GITHUB_REPOSITORY: "ci/project" } })?.url,
			"https://github.com/ci/project");
		assert.equal(resolveReleaseRepository({ projectDir, env: { LH_RELEASE_REPOSITORY: "explicit/project", GITHUB_REPOSITORY: "ci/project" } })?.url,
			"https://github.com/explicit/project");
	} finally { rmSync(projectDir, { recursive: true, force: true }); }
});

test("explicit identity takes precedence over Actions, which works without an override", () => {
	assert.equal(resolveReleaseRepository({ env: {
		LH_RELEASE_REPOSITORY: "maintainer/artifact-only", GITHUB_REPOSITORY: "workflow/repository",
	} })?.url, "https://github.com/maintainer/artifact-only");
	assert.equal(resolveReleaseRepository({ env: { GITHUB_REPOSITORY: "workflow/repository" } })?.url,
		"https://github.com/workflow/repository");
});

test("invalid first-applicable environment identity never falls through or leaks input", () => {
	for (const value of ["", " ", "owner", "owner/repo/extra", "-owner/repo", "owner-/repo", "owner--name/repo",
		"owner/.", "owner/..", "owner/repo?token=secret-token", "https://secret-token@github.com/owner/repo", "owner/repo\n"]) {
		assert.throws(() => resolveReleaseRepository({ env: {
			LH_RELEASE_REPOSITORY: value, GITHUB_REPOSITORY: "valid/fallback",
		}, required: false }), { message: "Invalid LH_RELEASE_REPOSITORY: expected a GitHub owner/repo." });
		assert.throws(() => resolveReleaseRepository({ env: { GITHUB_REPOSITORY: value }, required: false }),
			{ message: "Invalid GITHUB_REPOSITORY: expected a GitHub owner/repo." });
	}
	assert.deepEqual(resolveReleaseRepository({ env: { LH_RELEASE_REPOSITORY: "Some-Owner/Learning_Fork.v2" } }), {
		owner: "some-owner", repo: "learning_fork.v2", url: "https://github.com/some-owner/learning_fork.v2",
	});
});

test("explicit release identity supports arbitrary forks and the upstream repository", () => {
	assert.deepEqual(resolveReleaseRepository({ env: { LH_RELEASE_REPOSITORY: "octocat/learning-fork" } }), {
		owner: "octocat", repo: "learning-fork", url: "https://github.com/octocat/learning-fork",
	});
	assert.deepEqual(resolveReleaseRepository({ env: { LH_RELEASE_REPOSITORY: "amosblomqvist/learnharness" } }), {
		owner: "amosblomqvist", repo: "learnharness", url: "https://github.com/amosblomqvist/learnharness",
	});
});
