import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8"));

/** Execute the workflow's real identity step; only the Actions environment is a fixture. */
function prepare(variable: string | undefined, event = "workflow_dispatch", ref = "refs/heads/topic") {
	const step = workflow.jobs.quality.steps.find((entry: any) => entry.id === "repository");
	assert.ok(step, "quality must resolve identity before dependent jobs");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workflow-"));
	const output = path.join(root, "output");
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(LH_RELEASE_REPOSITORY|GITHUB_|GIT_)/.test(key)) delete env[key];
	}
	Object.assign(env, {
		GITHUB_REPOSITORY: "Workflow-Owner/Learning-Fork", GITHUB_EVENT_NAME: event,
		GITHUB_REF: ref, GITHUB_OUTPUT: output,
	});
	assert.equal(step.env.LH_RELEASE_REPOSITORY_VARIABLE, "${{ vars.LH_RELEASE_REPOSITORY }}");
	if (variable !== undefined) env.LH_RELEASE_REPOSITORY_VARIABLE = variable;
	try {
		const result = spawnSync("bash", ["-e", "-c", step.run], { cwd: repoRoot, env, encoding: "utf8" });
		return { ...result, output: fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "" };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("Desktop release — validated workflow identity", () => {
	it("uses automatic detection for absent/empty Actions vars and propagates a canonical override to all build consumers", () => {
		for (const variable of [undefined, "", "Other-Owner/Release-Fork"]) {
			const result = prepare(variable);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.output, variable ? "repository=other-owner/release-fork\n" : "repository=workflow-owner/learning-fork\n");
		}
		assert.equal(workflow.on.workflow_dispatch, null, "manual runs remain input-free");
		assert.equal(workflow.jobs.quality.outputs.repository, "${{ steps.repository.outputs.repository }}");
		assert.equal(workflow.jobs.package.env.LH_RELEASE_REPOSITORY, "${{ needs.quality.outputs.repository }}");
		assert.equal(workflow.jobs.verify.env.LH_RELEASE_REPOSITORY, "${{ needs.quality.outputs.repository }}");
		assert.ok(workflow.jobs.verify.needs.includes("quality"));
	});

	it("verifies actual Windows output for both modes before saving artifacts", () => {
		const steps = workflow.jobs.package.steps;
		const gate = steps.findIndex((step: any) => step.run === "npx tsx scripts/verify-release.ts package dist");
		assert.ok(gate > steps.findIndex((step: any) => step.run?.includes("--publish never")));
		assert.ok(gate > steps.findIndex((step: any) => step.run?.includes("--publish always")));
		assert.equal(steps[gate].if, undefined);
		assert.ok(gate < steps.findIndex((step: any) => step.uses?.startsWith("actions/upload-artifact")));
	});

	it("rejects cross-repository tag pushes before the draft job, but permits manual builds on ANY ref", async () => {
		assert.equal(workflow.jobs.draft.needs, "quality");
		const draft = workflow.jobs.draft.steps[0];
		assert.equal(draft.if, "github.event_name == 'push'");
		for (const ref of ["refs/heads/topic", "refs/tags/v0.6.1"]) {
			assert.equal(prepare("other-owner/release-fork", "workflow_dispatch", ref).status, 0);
		}
		const rejected = prepare("other-owner/release-fork", "push", "refs/tags/v0.6.1");
		assert.equal(rejected.status, 1);
		assert.match(rejected.stderr, /must match the workflow repository/);
		assert.equal(rejected.output, "", "failed identity must not reach dependent jobs");
		assert.equal(prepare("WORKFLOW-OWNER/LEARNING-FORK", "push", "refs/tags/v0.6.1").status, 0);
		const invalid = prepare("https://secret@github.com/wrong/repo");
		assert.equal(invalid.status, 1);
		assert.doesNotMatch(invalid.stderr, /secret/);

		// Execute the existing draft boundary against a fake external GitHub API.
		// It must still target context.repo, reuse one draft, and refuse races.
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
		const runDraft = new AsyncFunction("github", "context", "core", draft.with.script);
		for (const releases of [[], [{ id: 1, tag_name: "v0.6.1", draft: true }],
			[{ id: 1, tag_name: "v0.6.1", draft: false }],
			[{ id: 1, tag_name: "v0.6.1", draft: true }, { id: 2, tag_name: "0.6.1", draft: true }]]) {
			const writes: unknown[] = [];
			const github = {
				rest: { repos: { listReleases: "list", createRelease: async (args: unknown) => { writes.push(args); return { data: { id: 3 } }; } } },
				paginate: async (_method: unknown, args: unknown) => {
					assert.deepEqual(args, { owner: "workflow-owner", repo: "learning-fork", per_page: 100 });
					return releases;
				},
			};
			const run = () => runDraft(github, { repo: { owner: "workflow-owner", repo: "learning-fork" }, ref: "refs/tags/v0.6.1" }, { info() {} });
			if (releases.length > 1 || releases[0]?.draft === false) await assert.rejects(run, /Multiple releases|already published/);
			else await run();
			assert.deepEqual(writes, releases.length === 0 ? [{ owner: "workflow-owner", repo: "learning-fork", tag_name: "v0.6.1", name: "0.6.1", draft: true }] : []);
		}
	});
});
