/**
 * verify-release.ts — the final desktop-release gate (2026-10-13).
 *
 * Checks local Windows output in both release modes and runs in the release
 * workflow's LAST job after tag-triggered Windows packaging uploads
 * to the tag's single draft GitHub Release, and fails the workflow unless
 * that draft holds exactly what Windows end users and electron-updater
 * need. The workflow never publishes; this script only reads (release list
 * and update feed downloaded by the workflow's GET-only gh steps).
 *
 * Every expected file name below was verified against the INSTALLED
 * builder (app-builder-lib 26.16.1) — these are the artifacts it actually
 * emits for this repo's effective Builder configuration, not pattern guesses:
 *
 *   win (nsis x64; artifactName "${productName}-${version}-${arch}-setup.${ext}"):
 *     exe    LearnHarness-<v>-x64-setup.exe   + .blockmap (createBlockmap)
 *     feed   latest.yml — a single file entry, the exe.
 *
 * GitHub asset names equal these file names (all are already "safe" GitHub
 * names, so electron-publish uploads under the plain name) and every yml
 * files[].url equals the uploaded asset name.
 *
 * Draft selection is FAIL-CLOSED and replicates the existing matching used
 * by the workflow's draft job and electron-builder's GitHub publisher:
 * tag_name equals the tag ("v0.2.0") OR the bare version ("0.2.0"). Zero
 * matches, 2+ matches, or a published match → fail. A draft matched only
 * via the bare unprefixed form is a reported hazard: electron-builder
 * matches both spellings, so a later run could create a SECOND draft under
 * the v-tag and split the assets across two releases.
 *
 * CLI (cwd = the checked-out revision; package needs no tag or release API):
 *   tsx scripts/verify-release.ts package <dist-dir>
 *     → checks the actual baked public GitHub updater identity, nonempty
 *       installer/blockmap/feed, strict feed fields and the installer digest.
 *   tsx scripts/verify-release.ts select <releases.json> --tag <tag>
 *     → one JSON object on stdout: {releaseId, matchedTagName, warnings,
 *       assets:[{id,name,size,state}]}; diagnostics on stderr. Used by the
 *       workflow to locate the draft and its asset ids.
 *   tsx scripts/verify-release.ts verify <releases.json> <metadata-dir> --tag <tag>
 *     → full gate; human report on stdout; exit 0 only when everything
 *       below passes.
 *
 * The gate checks, and fails closed on any of:
 *   - tag ≠ "v" + package.json version, or a malformed release list;
 *   - effective Builder config/package.json drifting from the shapes the
 *     expected names were derived from (update this file's expectations
 *     when the packaging config changes — deliberately strict);
 *   - draft selection problems (above);
 *   - expected assets missing, zero-size, not in state "uploaded",
 *     duplicated, or unexpected extras (stale names from an older run);
 *   - update feeds that do not parse, carry the wrong version, reference
 *     a path/URL instead of a bare asset name (traversal / untrusted
 *     origin), reference an asset the release does not hold, disagree
 *     with the API-reported asset size, lack the installer entry, disagree
 *     with the legacy path/sha512 fields, or carry an
 *     implausible sha512.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveReleaseRepository } from "./release-repository.cjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): unknown };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReleaseAsset = { id: number; name: string; size: number; state: string };
export type ReleaseRecord = { id: number; tag_name: string; draft: boolean; assets: ReleaseAsset[] };

export type Failures = { ok: false; errors: string[] };
export type DraftSelection =
	| { ok: true; release: ReleaseRecord; warnings: string[] }
	| Failures;

/** The full Windows asset inventory for one version (3 files). */
export type ExpectedAssets = {
	version: string;
	win: { exe: string; feed: string };
	/** Every asset name the draft must hold, and no others. */
	files: string[];
};

type Issue = string;
type Issues = Issue[];

// ---------------------------------------------------------------------------
// Version + expected assets
// ---------------------------------------------------------------------------

/** Verified product name spelled into every artifact (Builder productName). */
const PRODUCT_NAME = "LearnHarness";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function checkVersion(version: unknown): { ok: true; version: string } | { ok: false; errors: Issues } {
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
		return { ok: false, errors: [`package.json version must be a plain semver string, got ${JSON.stringify(version)}`] };
	}
	return { ok: true, version };
}

/** The exact asset set the builder emits for this repo's Windows release. */
export function expectedAssets(version: string): ExpectedAssets {
	const win = {
		exe: `${PRODUCT_NAME}-${version}-x64-setup.exe`,
		feed: "latest.yml",
	};
	return {
		version,
		win,
		files: [win.exe, `${win.exe}.blockmap`, win.feed],
	};
}

// ---------------------------------------------------------------------------
// Release-list parsing (fail closed on any malformed entry)
// ---------------------------------------------------------------------------

/**
 * `gh api --paginate --slurp` emits an array of pages ([[...], [...]]); a
 * hand-made single page is a plain array. Both are accepted, everything
 * else fails.
 */
export function normalizeReleasePages(input: unknown): { ok: true; releases: unknown[] } | { ok: false; errors: Issues } {
	if (!Array.isArray(input)) {
		return { ok: false, errors: ["release list is not a JSON array"] };
	}
	const pages = input.length > 0 && Array.isArray(input[0]) ? input : [input];
	return { ok: true, releases: pages.flat() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleases(entries: unknown[]): { ok: true; releases: ReleaseRecord[] } | { ok: false; errors: Issues } {
	const errors: Issues = [];
	const releases: ReleaseRecord[] = [];
	entries.forEach((entry, index) => {
		const label = `releases[${index}]`;
		if (!isPlainObject(entry)) {
			errors.push(`${label}: not an object`);
			return;
		}
		const id = entry.id;
		const tagName = entry.tag_name;
		const draft = entry.draft;
		const assets = entry.assets;
		if (typeof id !== "number" || !Number.isFinite(id)) errors.push(`${label}: id is not a number`);
		if (typeof tagName !== "string" || tagName === "") errors.push(`${label}: tag_name is not a non-empty string`);
		if (typeof draft !== "boolean") errors.push(`${label}: draft is not a boolean`);
		const parsedAssets: ReleaseAsset[] = [];
		if (!Array.isArray(assets)) {
			errors.push(`${label}: assets is not an array`);
		} else {
			assets.forEach((asset, assetIndex) => {
				const assetLabel = `${label}.assets[${assetIndex}]`;
				if (!isPlainObject(asset)) {
					errors.push(`${assetLabel}: not an object`);
					return;
				}
				const { id: assetId, name, size, state } = asset;
				const assetOk =
					typeof assetId === "number" && Number.isFinite(assetId) &&
					typeof name === "string" && name !== "" &&
					typeof size === "number" && Number.isFinite(size) &&
					typeof state === "string" && state !== "";
				if (!assetOk) {
					errors.push(`${assetLabel}: needs numeric id, non-empty string name, numeric size, non-empty string state`);
					return;
				}
				parsedAssets.push({ id: assetId, name, size, state });
			});
		}
		if (typeof id === "number" && typeof tagName === "string" && tagName !== "" && typeof draft === "boolean") {
			releases.push({ id, tag_name: tagName, draft, assets: parsedAssets });
		}
	});
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, releases };
}

// ---------------------------------------------------------------------------
// Draft selection (replicates the draft job's + builder's matching, fail-closed)
// ---------------------------------------------------------------------------

export function selectDraft(releases: ReleaseRecord[], tag: string, version: string): DraftSelection {
	const matches = releases.filter((release) => release.tag_name === tag || release.tag_name === version);
	if (matches.length === 0) {
		return {
			ok: false,
			errors: [
				`no release matches "${tag}" or "${version}" — the draft job should have prepared exactly one draft; refusing to pass`,
			],
		};
	}
	if (matches.length > 1) {
		const list = matches.map((release) => `#${release.id} (${release.tag_name}, ${release.draft ? "draft" : "published"})`).join(", ");
		return { ok: false, errors: [`${matches.length} releases match ${tag}: ${list} — resolve to exactly one before publishing`] };
	}
	const [match] = matches;
	if (!match) return { ok: false, errors: ["internal: empty match"] };
	if (!match.draft) {
		return {
			ok: false,
			errors: [`release #${match.id} (${match.tag_name}) is already published — the workflow never modifies a published release`],
		};
	}
	const warnings: string[] = [];
	if (match.tag_name !== tag) {
		warnings.push(
			`draft #${match.id} carries the unprefixed tag "${match.tag_name}" instead of "${tag}": electron-builder matches both spellings, ` +
			`so a future run could create a SECOND draft under "${tag}" and split the assets — rename the release to "${tag}" before publishing`,
		);
	}
	return { ok: true, release: match, warnings };
}

// ---------------------------------------------------------------------------
// Packaging-config drift guard
// ---------------------------------------------------------------------------

/** Names below were derived from these exact config shapes; drift means the
 *  expectations in this file must be re-derived against the new builder
 *  output. Failing here is deliberate: a silently stale gate is worse. */
type ReleaseRepository = { owner: string; repo: string };

export function verifyConfigAssumptions(config: unknown, pkg: unknown, repository: ReleaseRepository): { ok: true } | { ok: false; errors: Issues } {
	const errors: Issues = [];
	const bad = (message: string) => errors.push(message);
	if (!isPlainObject(pkg) || typeof pkg.version !== "string") bad("package.json has no string version");
	if (!isPlainObject(pkg) || pkg.name !== "learnharness") bad("package.json name is no longer \"learnharness\"");
	if (!isPlainObject(config)) {
		return { ok: false, errors: ["effective Builder configuration is not a mapping", ...errors] };
	}
	if (config.productName !== PRODUCT_NAME) bad(`productName is ${JSON.stringify(config.productName)}, expected "${PRODUCT_NAME}"`);
	if (config.artifactName != null) bad("a top-level artifactName now overrides target defaults — expected names no longer hold");
	const sameTargets = (actual: unknown, expected: Array<Record<string, unknown>>) =>
		JSON.stringify(actual) === JSON.stringify(expected);
	if (!isPlainObject(config.win)) bad("win section missing");
	else {
		if (config.win.artifactName !== "${productName}-${version}-${arch}-setup.${ext}") {
			bad(`win.artifactName changed (${JSON.stringify(config.win.artifactName)}) — expected names no longer hold`);
		}
		if (!sameTargets(config.win.target, [{ target: "nsis", arch: ["x64"] }])) {
			bad(`win.target changed (${JSON.stringify(config.win.target)}) — expected names no longer hold`);
		}
	}
	const publish = Array.isArray(config.publish) && config.publish.length === 1 ? config.publish[0] : undefined;
	if (!isPlainObject(publish) || publish.provider !== "github" || publish.releaseType !== "draft") {
		bad('publish must contain exactly one github provider with releaseType "draft" — uploads would not land in the draft');
	} else if (publish.owner !== repository.owner || publish.repo !== repository.repo ||
		Object.keys(publish).some((key) => !["provider", "owner", "repo", "releaseType"].includes(key))) {
		bad("publish destination must contain only the selected public GitHub release repository");
	}
	const checkNestedPublish = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return;
		if (Object.hasOwn(value, "publish")) bad("nested publish overrides must not replace the selected release repository");
		for (const child of Object.values(value)) checkNestedPublish(child);
	};
	for (const [key, value] of Object.entries(config)) {
		if (key !== "publish") checkNestedPublish(value);
	}
	if (errors.length > 0) {
		errors.push("packaging config drifted from the verified shapes — re-derive the expected assets in scripts/verify-release.ts");
		return { ok: false, errors };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Asset inventory
// ---------------------------------------------------------------------------

export function verifyAssets(release: ReleaseRecord, expected: ExpectedAssets): { ok: true } | { ok: false; errors: Issues } {
	const errors: Issues = [];
	const seen = new Map<string, ReleaseAsset>();
	for (const asset of release.assets) {
		if (seen.has(asset.name)) errors.push(`duplicate asset name on the release: ${asset.name}`);
		else seen.set(asset.name, asset);
		// Checked for EVERY entry, duplicates included — fail closed.
		if (asset.state !== "uploaded") errors.push(`${asset.name}: state is "${asset.state}", not "uploaded"`);
		if (!(asset.size > 0)) errors.push(`${asset.name}: zero-size asset (size=${asset.size})`);
		if (!expected.files.includes(asset.name)) {
			errors.push(`${asset.name}: unexpected asset — not in the expected set (stale name from an older run?)`);
		}
	}
	for (const name of expected.files) {
		if (!seen.has(name)) errors.push(`${name}: missing from the release`);
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Update-feed (latest*.yml) verification
// ---------------------------------------------------------------------------

type FeedExpectation = {
	file: string;
	/** Every files[].url the feed must reference — exactly these, no more. */
	urls: string[];
};

export function feedExpectations(expected: ExpectedAssets): FeedExpectation[] {
	return [{ file: expected.win.feed, urls: [expected.win.exe] }];
}

/** An updater reference must be a bare file name: no directories, no
 *  traversal, no URI scheme, no query/fragment. Anything else is a path the
 *  updater could be steered with. */
export function isPlainAssetName(url: unknown): url is string {
	return typeof url === "string" && url !== "" && url !== "." && url !== ".." &&
		!url.includes("/") && !url.includes("\\") && !url.includes(":") && !url.includes("?") && !url.includes("#") && !url.startsWith("~");
}

const SHA512_BASE64 = /^[A-Za-z0-9+/]{80,}={0,2}$/;

type FeedFileEntry = { url: string; sha512: string; size: number };

export function verifyMetadataFiles(
	files: Record<string, string>,
	release: ReleaseRecord,
	expected: ExpectedAssets,
): { ok: true } | { ok: false; errors: Issues } {
	const errors: Issues = [];
	const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
	const expectations = feedExpectations(expected);

	for (const expectation of expectations) {
		const content = files[expectation.file];
		if (content == null) {
			errors.push(`${expectation.file}: not downloaded (or empty) — cannot verify the update feed`);
			continue;
		}
		let info: unknown;
		try {
			info = yaml.load(content);
		} catch (error) {
			errors.push(`${expectation.file}: does not parse as YAML (${String(error)})`);
			continue;
		}
		if (!isPlainObject(info)) {
			errors.push(`${expectation.file}: top level is not a mapping`);
			continue;
		}
		if (info.version !== expected.version) {
			errors.push(`${expectation.file}: version is ${JSON.stringify(info.version)}, expected "${expected.version}"`);
		}
		if (!Array.isArray(info.files) || info.files.length === 0) {
			errors.push(`${expectation.file}: no files[] entries`);
			continue;
		}
		const entries: FeedFileEntry[] = [];
		let malformed = false;
		info.files.forEach((entry, index) => {
			if (!isPlainObject(entry)) {
				errors.push(`${expectation.file}: files[${index}] is not a mapping`);
				malformed = true;
				return;
			}
			const { url, sha512, size } = entry;
			if (!isPlainAssetName(url)) {
				errors.push(`${expectation.file}: files[${index}].url is not a bare asset name (${JSON.stringify(entry.url)}) — traversal or untrusted origin`);
				malformed = true;
				return;
			}
			if (typeof sha512 !== "string" || !SHA512_BASE64.test(sha512)) {
				errors.push(`${expectation.file}: files[${index}] (${entry.url}): sha512 is not a base64 digest`);
				malformed = true;
				return;
			}
			if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
				errors.push(`${expectation.file}: files[${index}] (${entry.url}): size must be a positive integer`);
				malformed = true;
				return;
			}
			entries.push({ url, sha512, size });
		});
		if (malformed) continue;
		const urls = entries.map((entry) => entry.url);
		for (const url of urls) {
			const asset = byName.get(url);
			if (asset == null) {
				errors.push(`${expectation.file}: references "${url}" which is not an asset of release #${release.id}`);
			} else if (asset.size !== entries.find((entry) => entry.url === url)?.size) {
				errors.push(`${expectation.file}: "${url}" size ${entries.find((entry) => entry.url === url)?.size} ≠ release asset size ${asset.size}`);
			}
		}
		const expectedSet = [...expectation.urls].sort().join("\n");
		const actualSet = [...urls].sort().join("\n");
		if (actualSet !== expectedSet) {
			errors.push(`${expectation.file}: references [${urls.join(", ")}] but must reference exactly [${expectation.urls.join(", ")}]`);
		}
		// Legacy single-file fields electron-updater still reads on some paths:
		// the builder backs them with files[0].
		const first = entries[0];
		if (first) {
			if (info.path !== first.url) {
				errors.push(`${expectation.file}: top-level path is ${JSON.stringify(info.path)}, must be "${first.url}"`);
			}
			if (info.sha512 !== first.sha512) {
				errors.push(`${expectation.file}: top-level sha512 does not match files[0] (${first.url})`);
			}
		}
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Local Windows package gate — actual emitted files, never release API calls.
// ---------------------------------------------------------------------------

function fileSha512(file: string): string {
	const hash = createHash("sha512");
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(1024 * 1024);
		let size: number;
		while ((size = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, size));
		return hash.digest("base64");
	} finally {
		fs.closeSync(fd);
	}
}

function verifyWindowsPackage(distDir: string, expected: ExpectedAssets, repository: ReleaseRepository): Issues {
	const errors: Issues = [];
	try {
		const baked = yaml.load(fs.readFileSync(path.join(distDir, "win-unpacked", "resources", "app-update.yml"), "utf8"));
		const allowed = ["provider", "owner", "repo", "releaseType", "updaterCacheDirName"];
		if (!isPlainObject(baked) || baked.provider !== "github" || baked.owner !== repository.owner || baked.repo !== repository.repo ||
			baked.releaseType !== "draft" || Object.keys(baked).some((key) => !allowed.includes(key))) {
			errors.push("baked updater must contain only the selected public GitHub draft destination (app-update.yml)");
		}
	} catch {
		errors.push("cannot read or parse baked updater app-update.yml");
	}
	const assets: ReleaseAsset[] = [];
	for (const [id, name] of expected.files.entries()) {
		try {
			const stat = fs.statSync(path.join(distDir, name));
			if (!stat.isFile()) throw new Error("not a file");
			assets.push({ id, name, size: stat.size, state: "uploaded" });
		} catch {
			errors.push(`${name}: missing or not a regular file in the Windows package output`);
		}
	}
	const release: ReleaseRecord = { id: 0, tag_name: "local", draft: true, assets };
	const inventory = verifyAssets(release, expected);
	if (!inventory.ok) errors.push(...inventory.errors);
	try {
		const content = fs.readFileSync(path.join(distDir, expected.win.feed), "utf8");
		const metadata = verifyMetadataFiles({ [expected.win.feed]: content }, release, expected);
		if (!metadata.ok) errors.push(...metadata.errors);
		else {
			const feed = yaml.load(content) as { sha512: string };
			if (feed.sha512 !== fileSha512(path.join(distDir, expected.win.exe))) {
				errors.push(`${expected.win.feed}: sha512 does not match the actual Windows installer`);
			}
		}
	} catch {
		errors.push(`cannot read ${expected.win.feed} or its Windows installer`);
	}
	return errors;
}

// ---------------------------------------------------------------------------
// CLI (thin: parse args, read files, run the pure core, print, exit)
// ---------------------------------------------------------------------------

function usage(): string {
	return [
		"usage:",
		"  verify-release.ts package <dist-dir> (offline; no tag required)",
		"  verify-release.ts select <releases.json> --tag <tag>",
		"  verify-release.ts verify <releases.json> <metadata-dir> --tag <tag>",
	].join("\n");
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
	let source: string;
	try {
		source = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { ok: false, error: `cannot read ${file}: ${String(error)}` };
	}
	try {
		return { ok: true, value: JSON.parse(source) };
	} catch (error) {
		return { ok: false, error: `${file} is not valid JSON: ${String(error)}` };
	}
}

function loadReleases(file: string): { ok: true; releases: ReleaseRecord[] } | { ok: false; errors: Issues } {
	const json = readJson(file);
	if (!json.ok) return { ok: false, errors: [json.error] };
	const normalized = normalizeReleasePages(json.value);
	if (!normalized.ok) return normalized;
	return parseReleases(normalized.releases);
}

/** Reads package.json (version) + the composed Builder config from cwd —
 *  the workflow checks out the tagged revision before running the gate. */
function loadRepoConfig(): { ok: true; pkg: unknown; config: unknown; repository: ReleaseRepository } | { ok: false; errors: Issues } {
	const pkg = readJson("package.json");
	if (!pkg.ok) return { ok: false, errors: [pkg.error] };
	try {
		const projectDir = process.cwd();
		const repository = resolveReleaseRepository({ projectDir });
		if (!repository) throw new Error("Release repository is required");
		// Use Builder's public default loader (including package.json.build precedence),
		// not a direct adapter call. Isolate its logs from select's machine JSON;
		// fd 3 carries only the validated configuration, and is never printed.
		const loaded = spawnSync(process.execPath, ["-e", `
			const { Packager } = require(process.argv[1]);
			const packager = new Packager({ projectDir: process.cwd(), publish: "never" });
			packager.validateConfig().then(() => require("node:fs").writeFileSync(3, JSON.stringify(packager.config)))
				.catch(() => { process.exitCode = 1; });
		`, require.resolve("electron-builder")], {
			cwd: projectDir, encoding: "utf8", timeout: 60_000,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		if (loaded.status !== 0) throw new Error("Builder default configuration failed validation");
		return { ok: true, pkg: pkg.value, config: JSON.parse(String(loaded.output[3])), repository };
	} catch (error) {
		return { ok: false, errors: [`cannot load effective Builder configuration: ${String(error)}`] };
	}
}

function fail(errors: Issues): number {
	for (const error of errors) console.error(`ERROR: ${error}`);
	console.error("FAILED: the draft release gate found problems — do not publish; fix and re-run the release workflow.");
	return 1;
}

function parseArgs(argv: string[]): { ok: true; command: string; positional: string[]; tag?: string } | { ok: false; errors: Issues } {
	const positional: string[] = [];
	let tag: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--tag") {
			tag = argv[++i];
			if (tag == null || tag === "") return { ok: false, errors: ["--tag needs a value"] };
		} else {
			positional.push(arg);
		}
	}
	const [command] = positional;
	if (command !== "select" && command !== "verify") return { ok: false, errors: [usage()] };
	return { ok: true, command, positional: positional.slice(1), tag };
}

/** Tag ↔ version agreement + release-list load, shared by both commands. */
function startGate(argv: string[]):
	| { ok: true; tag: string; version: string; releases: ReleaseRecord[]; config: unknown; pkg: unknown; repository: ReleaseRepository; positional: string[] }
	| { ok: false; errors: Issues } {
	const parsed = parseArgs(argv);
	if (!parsed.ok) return parsed;
	const releasesFile = parsed.positional[0];
	if (parsed.tag == null) return { ok: false, errors: ["--tag is required (the pushed tag, e.g. v0.2.0)"] };
	if (releasesFile == null) return { ok: false, errors: [usage()] };
	const repo = loadRepoConfig();
	if (!repo.ok) return repo;
	const versioned = checkVersion(isPlainObject(repo.pkg) ? repo.pkg.version : undefined);
	if (!versioned.ok) return versioned;
	const expectedTag = `v${versioned.version}`;
	if (parsed.tag !== expectedTag) {
		return { ok: false, errors: [`tag ${parsed.tag} does not equal "v" + package.json version ("${expectedTag}")`] };
	}
	const releases = loadReleases(releasesFile);
	if (!releases.ok) return releases;
	return {
		ok: true,
		tag: parsed.tag,
		version: versioned.version,
		releases: releases.releases,
		config: repo.config,
		pkg: repo.pkg,
		repository: repo.repository,
		positional: parsed.positional,
	};
}

function main(argv: string[]): number {
	if (argv[0] === "package") {
		if (argv.length !== 2) return fail([usage()]);
		const repo = loadRepoConfig();
		if (!repo.ok) return fail(repo.errors);
		const version = checkVersion(isPlainObject(repo.pkg) ? repo.pkg.version : undefined);
		if (!version.ok) return fail(version.errors);
		const config = verifyConfigAssumptions(repo.config, repo.pkg, repo.repository);
		if (!config.ok) return fail(config.errors);
		const errors = verifyWindowsPackage(argv[1]!, expectedAssets(version.version), repo.repository);
		if (errors.length > 0) return fail(errors);
		console.log(`OK: Windows package has the selected baked updater, installer, blockmap, and verified ${expectedAssets(version.version).win.feed}.`);
		return 0;
	}
	const start = startGate(argv);
	if (!start.ok) return fail(start.errors);
	const expected = expectedAssets(start.version);

	if (argv[0] === "select") {
		const selection = selectDraft(start.releases, start.tag, start.version);
		if (!selection.ok) return fail(selection.errors);
		for (const warning of selection.warnings) console.error(`WARNING: ${warning}`);
		const report = {
			releaseId: selection.release.id,
			tag: start.tag,
			matchedTagName: selection.release.tag_name,
			warnings: selection.warnings,
			assets: selection.release.assets.map((asset) => ({ id: asset.id, name: asset.name, size: asset.size, state: asset.state })),
		};
		process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
		return 0;
	}

	// verify
	const metadataDir = start.positional[1];
	if (metadataDir == null) return fail([usage()]);
	const errors: Issues = [];
	const assumptions = verifyConfigAssumptions(start.config, start.pkg, start.repository);
	if (!assumptions.ok) errors.push(...assumptions.errors);
	const selection = selectDraft(start.releases, start.tag, start.version);
	if (!selection.ok) return fail([...errors, ...selection.errors]);
	console.log(`draft release #${selection.release.id} — tag "${selection.release.tag_name}"`);
	for (const warning of selection.warnings) console.log(`WARNING: ${warning}`);
	const assets = verifyAssets(selection.release, expected);
	if (!assets.ok) errors.push(...assets.errors);
	const files: Record<string, string> = {};
	for (const { file: name } of feedExpectations(expected)) {
		try {
			files[name] = fs.readFileSync(path.join(metadataDir, name), "utf8");
		} catch {
			// verifyMetadataFiles reports the missing feed by name.
		}
	}
	const metadata = verifyMetadataFiles(files, selection.release, expected);
	if (!metadata.ok) errors.push(...metadata.errors);
	if (errors.length > 0) return fail(errors);
	const present = expected.files.filter((name) => selection.release.assets.some((asset) => asset.name === name));
	console.log(`assets: ${present.length}/${expected.files.length} expected files present, non-zero size, and "uploaded"`);
	console.log(`feed: ${expected.win.feed} parses, carries version ${start.version}, and references only the uploaded installer by exact name`);
	console.log(`OK: draft for ${start.tag} is complete and consistent — ready for the owner to review and publish.`);
	return 0;
}

const invokedAsCli = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) process.exitCode = main(process.argv.slice(2));
