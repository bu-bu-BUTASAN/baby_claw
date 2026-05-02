import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const artifactPath = resolve(root, "src/artifacts/baby_claw_package.json");

async function readJson(relativePath) {
	const file = resolve(root, relativePath);
	return JSON.parse(await readFile(file, "utf8"));
}

async function collectFiles(dir, extension) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = resolve(dir, entry.name);

			if (entry.isDirectory()) {
				return collectFiles(path, extension);
			}

			if (entry.isFile() && extname(entry.name) === extension) {
				return [path];
			}

			return [];
		}),
	);

	return files.flat();
}

async function computeContractSourceHash() {
	const sourceFiles = await collectFiles(
		resolve(root, "contracts/sources"),
		".move",
	);
	const files = [
		resolve(root, "contracts/Move.toml"),
		resolve(root, "contracts/Move.lock"),
		...sourceFiles,
	].sort();
	const hash = createHash("sha256");

	for (const file of files) {
		hash.update(file.slice(root.length + 1));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}

	return `sha256:${hash.digest("hex")}`;
}

function distImport(relativePath) {
	return import(`${resolve(root, relativePath)}?t=${Date.now()}`);
}

test("package metadata exposes the contract artifact build script", async () => {
	const packageJson = await readJson("package.json");

	assert.equal(packageJson.packageManager, "bun@1.3.2");
	assert.equal(
		packageJson.scripts?.["build:contract-artifact"],
		"bun scripts/build-contract-artifact.ts",
	);
	assert.equal(packageJson.devDependencies?.tsx, undefined);
});

test("runtime contract artifact is present, deterministic, and source-fresh", async () => {
	assert.equal(
		existsSync(artifactPath),
		true,
		"expected src/artifacts/baby_claw_package.json to exist",
	);

	const artifact = await readJson("src/artifacts/baby_claw_package.json");
	const packageJson = await readJson("package.json");

	assert.deepEqual(Object.keys(artifact), [
		"modules",
		"dependencies",
		"sourceHash",
		"contractVersion",
	]);
	assert.equal(Array.isArray(artifact.modules), true);
	assert.equal(artifact.modules.length > 0, true);
	for (const module of artifact.modules) {
		assert.match(module, /^[A-Za-z0-9+/]+={0,2}$/);
	}

	assert.equal(Array.isArray(artifact.dependencies), true);
	assert.equal(artifact.dependencies.length > 0, true);
	for (const dependency of artifact.dependencies) {
		assert.match(dependency, /^0x[0-9a-fA-F]+$/);
	}

	assert.equal(artifact.contractVersion, packageJson.version);
	assert.match(artifact.sourceHash, /^sha256:[0-9a-f]{64}$/);
	assert.equal(artifact.sourceHash, await computeContractSourceHash());

	const raw = await readFile(artifactPath, "utf8");
	assert.equal(raw.endsWith("\n"), true);
	assert.equal(raw.includes("generatedAt"), false);
	assert.equal(basename(artifactPath), "baby_claw_package.json");
});

test("compiled contract artifact entrypoint exposes typed publish inputs", async () => {
	const { babyClawPackageArtifact } = await distImport(
		"dist/artifacts/babyClawPackage.js",
	);
	const artifact = await readJson("src/artifacts/baby_claw_package.json");

	assert.deepEqual(babyClawPackageArtifact, artifact);
	assert.equal(Array.isArray(babyClawPackageArtifact.modules), true);
	assert.equal(Array.isArray(babyClawPackageArtifact.dependencies), true);
});

test("contract artifact check succeeds for a clean generated artifact", async () => {
	const result = await execFileAsync(
		"bun",
		["run", "--silent", "build:contract-artifact", "--", "--check"],
		{
			cwd: root,
			env: process.env,
		},
	);

	assert.equal(result.stderr, "");
});

test("contract artifact check validates source freshness when sui is unavailable", async () => {
	assert.equal(typeof process.versions.bun, "string");

	const tempBin = await mkdtemp(resolve(tmpdir(), "baby-claw-no-sui-"));

	try {
		await symlink(process.execPath, resolve(tempBin, "bun"));
		await symlink(process.execPath, resolve(tempBin, "node"));
		await symlink("/bin/sh", resolve(tempBin, "sh"));

		const result = await execFileAsync(
			process.execPath,
			["run", "--silent", "build:contract-artifact", "--", "--check"],
			{
				cwd: root,
				env: {
					...process.env,
					PATH: tempBin,
				},
			},
		);

		assert.equal(result.stderr, "");
	} finally {
		await rm(tempBin, { recursive: true, force: true });
	}
});
