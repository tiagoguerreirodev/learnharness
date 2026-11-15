"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync, realpathSync } = require("node:fs");
const path = require("node:path");

function applicationOrigin(projectDir, env) {
	// A source archive must not discover an enclosing checkout. Git still owns
	// .git directory/file resolution, including linked worktree indirection.
	if (!existsSync(path.join(projectDir, ".git"))) return null;
	const gitEnv = { ...process.env, ...env };
	for (const key of Object.keys(gitEnv)) {
		if (key.toUpperCase().startsWith("GIT_")) delete gitEnv[key];
	}
	const git = (...args) => execFileSync("git", ["-C", projectDir, ...args], {
		env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
	}).replace(/\r?\n$/, "");
	try {
		const top = git("rev-parse", "--show-toplevel");
		if (path.relative(realpathSync(projectDir), realpathSync(top)) !== "") return null;
		let worktreeConfig = false;
		try {
			worktreeConfig = git("config", "--local", "--bool", "--get", "extensions.worktreeConfig") === "true";
		} catch (error) {
			if (error.status !== 1) throw error;
		}
		if (worktreeConfig) {
			try {
				return git("config", "--worktree", "--get", "remote.origin.url");
			} catch (error) {
				if (error.status !== 1) throw error;
			}
		}
		return git("config", "--local", "--get", "remote.origin.url");
	} catch {
		// Missing Git/origin and unreadable metadata share the missing-identity
		// policy. Never surface Git's diagnostics (which can contain secrets).
		return null;
	}
}

function publicRepository(value, source) {
	const match = typeof value === "string" && /^([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})\/([a-z\d._-]{1,100})$/i.exec(value);
	if (!match || match[0] !== value || match[2] === "." || match[2] === "..") {
		throw new Error(`Invalid ${source}: expected a GitHub owner/repo.`);
	}
	const owner = match[1].toLowerCase();
	const repo = match[2].toLowerCase();
	return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/**
 * Shared build-time GitHub identity. Only public, normalized metadata leaves
 * this boundary; neither origin credentials nor raw inputs belong in errors.
 * @param {{ projectDir?: string, env?: Record<string, string | undefined>, required?: boolean }} [options]
 * @returns {{ owner: string, repo: string, url: string } | null}
 */
function resolveReleaseRepository({ projectDir = path.resolve(__dirname, ".."), env = process.env, required = true } = {}) {
	for (const source of ["LH_RELEASE_REPOSITORY", "GITHUB_REPOSITORY"]) {
		if (env[source] !== undefined) return publicRepository(env[source], source);
	}
	const origin = applicationOrigin(projectDir, env);
	if (origin === null) {
		if (!required) return null;
		throw new Error("Cannot resolve the application's GitHub release repository. Set LH_RELEASE_REPOSITORY=owner/repo for this build.");
	}
	const match = /^(?:https:\/\/(?:[^\s/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s?#]+?)(?:\.git)?\/?$/i.exec(origin);
	return publicRepository(match && match[0] === origin && match[1], "application Git origin");
}

module.exports = { resolveReleaseRepository };
