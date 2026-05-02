import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

async function readJson(relativePath) {
	const file = resolve(root, relativePath);
	return JSON.parse(await readFile(file, "utf8"));
}

function distImport(relativePath) {
	return import(`${resolve(root, relativePath)}?t=${Date.now()}`);
}

test("openclaw manifest declares baby_claw with the strict config schema", async () => {
	const manifestPath = resolve(root, "openclaw.plugin.json");

	assert.equal(existsSync(manifestPath), true);

	const manifest = await readJson("openclaw.plugin.json");

	assert.equal(manifest.id, "baby_claw");
	assert.equal(manifest.configSchema.type, "object");
	assert.equal(manifest.configSchema.additionalProperties, false);
	assert.deepEqual(Object.keys(manifest.configSchema.properties).sort(), [
		"encryptImages",
		"stateDir",
		"suiNetwork",
		"suiPrivateKey",
		"walrusAggregatorUrl",
		"walrusPublisherUrl",
	]);
	assert.equal(manifest.configSchema.properties.packageId, undefined);
	assert.equal(manifest.uiHints?.suiPrivateKey?.sensitive, true);
});

test("openclaw manifest declares the healthcheck and status tool contracts", async () => {
	const manifest = await readJson("openclaw.plugin.json");

	assert.deepEqual(manifest.skills, ["skills/baby_claw"]);
	assert.deepEqual(manifest.contracts?.tools, [
		"baby_claw_healthcheck",
		"baby_claw_status",
	]);
});

test("package metadata exposes OpenClaw dev and runtime entries", async () => {
	const packageJson = await readJson("package.json");

	assert.equal(packageJson.type, "module");
	assert.equal(packageJson.scripts?.build, "tsc -p tsconfig.json");
	assert.equal(packageJson.scripts?.test, "node --test tests/*.test.mjs");
	assert.deepEqual(packageJson.openclaw?.extensions, ["./src/index.ts"]);
	assert.deepEqual(packageJson.openclaw?.runtimeExtensions, [
		"./dist/index.js",
	]);
});

test("compiled plugin entry registers the baby_claw_healthcheck tool", async () => {
	const entryPath = resolve(root, "dist/index.js");

	assert.equal(
		existsSync(entryPath),
		true,
		"expected npm run build to create dist/index.js",
	);

	const { default: entry } = await distImport("dist/index.js");
	const registeredTools = [];
	const api = {
		pluginConfig: {},
		registerTool(tool, options) {
			registeredTools.push({ tool, options });
		},
	};

	assert.equal(entry.id, "baby_claw");
	assert.equal(typeof entry.register, "function");

	entry.register(api);

	assert.equal(registeredTools.length, 2);

	const { tool, options } = registeredTools.find(
		({ tool: registeredTool }) =>
			registeredTool.name === "baby_claw_healthcheck",
	);

	assert.equal(tool.name, "baby_claw_healthcheck");
	assert.equal(options, undefined);
	assert.equal(tool.parameters?.type, "object");

	const result = await tool.execute("test-call", {});
	const text = result.content?.[0]?.text;

	assert.equal(result.content?.[0]?.type, "text");
	assert.deepEqual(JSON.parse(text), {
		ok: true,
		plugin: "baby_claw",
		version: "0.1.0",
	});
});

test("config schema normalizes defaults and rejects unsafe config shapes", async () => {
	const { normalizeBabyClawConfig, configSchema } =
		await distImport("dist/config.js");

	assert.deepEqual(normalizeBabyClawConfig({}), {
		suiNetwork: "testnet",
		stateDir: "~/.openclaw/baby_claw",
		encryptImages: true,
	});

	assert.equal(configSchema.validate({ packageId: "0x123" }).ok, false);
	assert.equal(configSchema.validate({ suiNetwork: "mainnet" }).ok, false);
	assert.equal(configSchema.validate({ walrusPublisherUrl: 123 }).ok, false);
	assert.equal(configSchema.validate({ unknownKey: true }).ok, false);
	assert.deepEqual(
		normalizeBabyClawConfig({
			suiNetwork: "devnet",
			stateDir: "/tmp/baby-claw",
			encryptImages: false,
			suiPrivateKey: "suiprivkey",
			walrusPublisherUrl: "https://publisher.example.com",
			walrusAggregatorUrl: "https://aggregator.example.com",
		}),
		{
			suiNetwork: "devnet",
			stateDir: "/tmp/baby-claw",
			encryptImages: false,
			suiPrivateKey: "suiprivkey",
			walrusPublisherUrl: "https://publisher.example.com",
			walrusAggregatorUrl: "https://aggregator.example.com",
		},
	);
});

test("state helpers return null for missing state and roundtrip valid state", async () => {
	const {
		isInitializedState,
		readBabyClawState,
		resolveBabyClawStatePath,
		writeBabyClawState,
	} = await distImport("dist/state.js");
	const tempRoot = await mkdtemp(resolve(tmpdir(), "baby-claw-state-"));

	try {
		assert.equal(
			resolveBabyClawStatePath({ stateDir: tempRoot }),
			resolve(tempRoot, "state.json"),
		);
		assert.equal(await readBabyClawState({ stateDir: tempRoot }), null);
		assert.equal(isInitializedState(null), false);

		const state = {
			initialized: true,
			network: "testnet",
			packageId: "0xpackage",
			profileId: "0xprofile",
			publishTxDigest: "publish-digest",
			mintTxDigest: "mint-digest",
			imageEncryptionKeyRef: "kms://baby-claw/key",
			createdAt: "2026-05-02T00:00:00.000Z",
			ignoredSecret: "must-not-persist",
		};

		await writeBabyClawState({ stateDir: tempRoot }, state);

		const raw = await readFile(resolve(tempRoot, "state.json"), "utf8");
		assert.equal(raw.includes("ignoredSecret"), false);
		assert.deepEqual(JSON.parse(raw), {
			initialized: true,
			network: "testnet",
			packageId: "0xpackage",
			profileId: "0xprofile",
			publishTxDigest: "publish-digest",
			mintTxDigest: "mint-digest",
			imageEncryptionKeyRef: "kms://baby-claw/key",
			createdAt: "2026-05-02T00:00:00.000Z",
		});
		assert.deepEqual(await readBabyClawState({ stateDir: tempRoot }), {
			initialized: true,
			network: "testnet",
			packageId: "0xpackage",
			profileId: "0xprofile",
			publishTxDigest: "publish-digest",
			mintTxDigest: "mint-digest",
			imageEncryptionKeyRef: "kms://baby-claw/key",
			createdAt: "2026-05-02T00:00:00.000Z",
		});
		assert.equal(
			isInitializedState(await readBabyClawState({ stateDir: tempRoot })),
			true,
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status tool reports initialization and config readiness without secrets", async () => {
	const tempRoot = await mkdtemp(resolve(tmpdir(), "baby-claw-status-"));

	try {
		const { default: entry } = await distImport("dist/index.js");
		const registeredTools = [];
		const api = {
			pluginConfig: {
				stateDir: tempRoot,
				suiPrivateKey: "private-key-secret",
				walrusPublisherUrl: "https://publisher.example.com",
				walrusAggregatorUrl: "https://aggregator.example.com",
			},
			registerTool(tool, options) {
				registeredTools.push({ tool, options });
			},
		};

		entry.register(api);

		const statusTool = registeredTools.find(
			({ tool }) => tool.name === "baby_claw_status",
		)?.tool;

		assert.equal(typeof statusTool?.execute, "function");

		const notInitialized = await statusTool.execute("test-call", {});
		assert.deepEqual(JSON.parse(notInitialized.content[0].text), {
			status: "not_initialized",
			initialized: false,
			config: {
				hasSuiPrivateKey: true,
				hasWalrusPublisherUrl: true,
				hasWalrusAggregatorUrl: true,
				readyForInit: true,
			},
		});

		const { writeBabyClawState } = await distImport("dist/state.js");
		await writeBabyClawState(
			{ stateDir: tempRoot },
			{
				initialized: true,
				network: "testnet",
				packageId: "0xpackage",
				profileId: "0xprofile",
				publishTxDigest: "publish-digest",
				mintTxDigest: "mint-digest",
				imageEncryptionKeyRef: "raw-encryption-key-material",
				createdAt: "2026-05-02T00:00:00.000Z",
			},
		);

		const initialized = await statusTool.execute("test-call", {});
		const payload = JSON.parse(initialized.content[0].text);
		const serialized = JSON.stringify(payload);

		assert.equal(payload.status, "initialized");
		assert.equal(payload.initialized, true);
		assert.equal(payload.network, "testnet");
		assert.equal(payload.packageId, "0xpackage");
		assert.equal(payload.profileId, "0xprofile");
		assert.equal(payload.publishTxDigest, "publish-digest");
		assert.equal(payload.mintTxDigest, "mint-digest");
		assert.equal(payload.createdAt, "2026-05-02T00:00:00.000Z");
		assert.equal(payload.imageEncryptionKeyRef, "configured");
		assert.equal(serialized.includes("private-key-secret"), false);
		assert.equal(serialized.includes("raw-encryption-key-material"), false);
		assert.equal(serialized.includes(tempRoot), false);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
