"use strict";

// Run before any release mutation. Only canonical public identity crosses jobs.
const { appendFileSync } = require("node:fs");
const { resolveReleaseRepository } = require("./release-repository.cjs");

try {
	const env = { ...process.env };
	// Actions renders absent repository variables as "". Do not turn that into
	// a defined (invalid) resolver override; automatic detection must still work.
	if (env.LH_RELEASE_REPOSITORY_VARIABLE) env.LH_RELEASE_REPOSITORY = env.LH_RELEASE_REPOSITORY_VARIABLE;
	const { owner, repo } = resolveReleaseRepository({ env });
	if (env.GITHUB_EVENT_NAME === "push") {
		const workflow = resolveReleaseRepository({ env: { GITHUB_REPOSITORY: env.GITHUB_REPOSITORY } });
		if (owner !== workflow.owner || repo !== workflow.repo) {
			throw new Error("Tag release repository must match the workflow repository before any release mutation.");
		}
	}
	appendFileSync(process.env.GITHUB_OUTPUT, `repository=${owner}/${repo}\n`);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
