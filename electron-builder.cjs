"use strict";

const { readFileSync } = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { resolveReleaseRepository } = require("./scripts/release-repository.cjs");

function rejectPublishDefinitions(value) {
	if (value === null || typeof value !== "object") return;
	if (Object.hasOwn(value, "publish")) {
		throw new Error("publish definitions must be supplied only by the repository adapter, not the YAML base.");
	}
	for (const child of Object.values(value)) rejectPublishDefinitions(child);
}

/**
 * Builder's default CJS config entry point, also used by configuration readers.
 * Always strict, including --publish never. Return fresh config for Builder's
 * normalization; do not cache a mutable YAML object or use config inheritance.
 * @param {{ projectDir?: string, env?: Record<string, string | undefined> }} [options]
 */
module.exports = function createBuilderConfig({ projectDir = __dirname, env = process.env } = {}) {
	const base = yaml.load(readFileSync(path.join(projectDir, "electron-builder.base.yml"), "utf8"));
	rejectPublishDefinitions(base);
	if (base.extends != null) throw new Error("YAML base must not extend other configurations; the repository adapter owns composition.");
	const { owner, repo } = resolveReleaseRepository({ projectDir, env });
	return { ...base, publish: [{ provider: "github", owner, repo, releaseType: "draft" }] };
};
