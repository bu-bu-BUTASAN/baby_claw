import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import process from "node:process";

type SuiBuildOutput = {
	modules: unknown;
	dependencies: unknown;
};

type BabyClawContractArtifact = {
	modules: string[];
	dependencies: string[];
	sourceHash: string;
	contractVersion: string;
};

const root = resolve(import.meta.dirname, "..");
const contractsDir = resolve(root, "contracts");
const artifactPath = resolve(root, "src/artifacts/baby_claw_package.json");
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const addressPattern = /^0x[0-9a-fA-F]+$/;

async function collectMoveFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = resolve(dir, entry.name);

			if (entry.isDirectory()) {
				return collectMoveFiles(path);
			}

			if (entry.isFile() && extname(entry.name) === ".move") {
				return [path];
			}

			return [];
		}),
	);

	return files.flat();
}

async function computeSourceHash(): Promise<string> {
	const moveFiles = await collectMoveFiles(resolve(contractsDir, "sources"));
	const files = [
		resolve(contractsDir, "Move.toml"),
		resolve(contractsDir, "Move.lock"),
		...moveFiles,
	].sort();
	const hash = createHash("sha256");

	for (const file of files) {
		hash.update(relative(root, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}

	return `sha256:${hash.digest("hex")}`;
}

function extractBuildJson(stdout: string): SuiBuildOutput {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");

	if (start === -1 || end === -1 || end < start) {
		throw new Error("sui move build output did not contain a JSON object");
	}

	return JSON.parse(stdout.slice(start, end + 1)) as SuiBuildOutput;
}

function validateStringArray(
	value: unknown,
	name: "modules" | "dependencies",
	pattern: RegExp,
): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`sui build output must include a non-empty ${name} array`);
	}

	for (const item of value) {
		if (typeof item !== "string" || !pattern.test(item)) {
			throw new Error(`sui build output included an invalid ${name} entry`);
		}
	}

	return value;
}

function validateArtifact(value: unknown): BabyClawContractArtifact {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("contract artifact must be a JSON object");
	}

	const artifact = value as Partial<BabyClawContractArtifact>;

	return {
		modules: validateStringArray(artifact.modules, "modules", base64Pattern),
		dependencies: validateStringArray(
			artifact.dependencies,
			"dependencies",
			addressPattern,
		),
		sourceHash: validateArtifactString(
			artifact.sourceHash,
			"sourceHash",
			/^sha256:[0-9a-f]{64}$/,
		),
		contractVersion: validateArtifactString(
			artifact.contractVersion,
			"contractVersion",
			/^.+$/,
		),
	};
}

function validateArtifactString(
	value: unknown,
	name: "sourceHash" | "contractVersion",
	pattern: RegExp,
): string {
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new Error(`contract artifact must include a valid ${name}`);
	}

	return value;
}

function readSuiBuildOutput(): SuiBuildOutput {
	const stdout = execFileSync(
		"sui",
		["move", "build", "--dump-bytecode-as-base64"],
		{
			cwd: contractsDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	return extractBuildJson(stdout);
}

async function readPackageVersion(): Promise<string> {
	const packageJson = JSON.parse(
		await readFile(resolve(root, "package.json"), "utf8"),
	) as { version?: unknown };

	if (
		typeof packageJson.version !== "string" ||
		packageJson.version.length === 0
	) {
		throw new Error("root package.json must include a non-empty version");
	}

	return packageJson.version;
}

async function buildArtifact(): Promise<BabyClawContractArtifact> {
	const buildOutput = readSuiBuildOutput();

	return {
		modules: validateStringArray(buildOutput.modules, "modules", base64Pattern),
		dependencies: validateStringArray(
			buildOutput.dependencies,
			"dependencies",
			addressPattern,
		),
		sourceHash: await computeSourceHash(),
		contractVersion: await readPackageVersion(),
	};
}

function formatArtifact(artifact: BabyClawContractArtifact): string {
	return `${JSON.stringify(
		{
			modules: artifact.modules,
			dependencies: artifact.dependencies,
			sourceHash: artifact.sourceHash,
			contractVersion: artifact.contractVersion,
		},
		null,
		"\t",
	)}\n`;
}

function isMissingSuiCli(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT" &&
		"syscall" in error &&
		typeof error.syscall === "string" &&
		error.syscall.includes("spawnSync sui")
	);
}

async function checkExistingArtifactWithoutSui(): Promise<string> {
	const artifact = validateArtifact(
		JSON.parse(await readFile(artifactPath, "utf8")),
	);
	const expected = formatArtifact({
		...artifact,
		sourceHash: await computeSourceHash(),
		contractVersion: await readPackageVersion(),
	});

	return expected;
}

async function main() {
	const args = process.argv.slice(2);
	const checkOnly = args.includes("--check");

	if (args.some((arg) => arg !== "--check")) {
		throw new Error("usage: npm run build:contract-artifact -- [--check]");
	}

	let expected: string;
	try {
		expected = formatArtifact(await buildArtifact());
	} catch (error) {
		if (!checkOnly || !isMissingSuiCli(error)) {
			throw error;
		}

		expected = await checkExistingArtifactWithoutSui();
	}

	if (checkOnly) {
		if (!existsSync(artifactPath)) {
			throw new Error(`${relative(root, artifactPath)} does not exist`);
		}

		const current = await readFile(artifactPath, "utf8");
		if (current !== expected) {
			throw new Error(
				`${relative(
					root,
					artifactPath,
				)} is stale; run npm run build:contract-artifact`,
			);
		}

		return;
	}

	await mkdir(dirname(artifactPath), { recursive: true });
	await writeFile(artifactPath, expected);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exitCode = 1;
});
