import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function distImport(relativePath) {
	return import(`${resolve(root, relativePath)}?t=${Date.now()}`);
}

async function withTempConfig(fn) {
	const stateDir = await mkdtemp(resolve(tmpdir(), "baby-claw-tools-"));
	try {
		await fn({
			suiNetwork: "testnet",
			stateDir,
			encryptImages: true,
			walrusEpochs: 1,
			suiPrivateKey: "private-key-secret",
			walrusPublisherUrl: "https://publisher.example.com",
			walrusAggregatorUrl: "https://aggregator.example.com",
		});
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
}

function parseToolResult(result) {
	return JSON.parse(result.content[0].text);
}

function createStored(blobId, createdAtMs = 1_777_603_200_000) {
	return {
		payloadBlobId: blobId,
		payloadHash: new Uint8Array([1, 2, 3]),
		recordCommitment: `commit-${blobId}`,
		createdAtMs,
	};
}

test("init tool publishes once, mints a profile, and is idempotent without leaking secrets", async () => {
	const { createBabyClawTools } = await distImport("dist/tools/step9.js");
	const { readBabyClawState } = await distImport("dist/state.js");

	await withTempConfig(async (config) => {
		const calls = [];
		const tools = createBabyClawTools(config, {
			publishUserPackage: async () => {
				calls.push("publish");
				return { packageId: "0xpackage", digest: "publish-digest" };
			},
			mintProfile: async () => {
				calls.push("mint");
				return { profileId: "0xprofile", digest: "mint-digest" };
			},
			now: () => new Date("2026-05-02T00:00:00.000Z"),
		});

		const initTool = tools.find((tool) => tool.name === "baby_claw_init");
		const first = parseToolResult(await initTool.execute("test-call", {}));
		const second = parseToolResult(await initTool.execute("test-call", {}));
		const serialized = JSON.stringify([first, second]);

		assert.deepEqual(calls, ["publish", "mint"]);
		assert.equal(first.status, "initialized");
		assert.equal(first.created, true);
		assert.equal(second.created, false);
		assert.equal(first.packageId, "0xpackage");
		assert.equal(first.profileId, "0xprofile");
		assert.equal(serialized.includes("private-key-secret"), false);
		assert.equal(serialized.includes(config.stateDir), false);
		assert.deepEqual(await readBabyClawState(config), {
			initialized: true,
			network: "testnet",
			packageId: "0xpackage",
			profileId: "0xprofile",
			publishTxDigest: "publish-digest",
			mintTxDigest: "mint-digest",
			imageEncryptionKeyRef: "local",
			createdAt: "2026-05-02T00:00:00.000Z",
		});
	});
});

test("record tools require initialization and write encrypted payload metadata to Sui", async () => {
	const { createBabyClawTools } = await distImport("dist/tools/step9.js");
	const { writeBabyClawState } = await distImport("dist/state.js");

	await withTempConfig(async (config) => {
		const uninitialized = createBabyClawTools(config);
		await assert.rejects(
			() =>
				uninitialized
					.find((tool) => tool.name === "baby_claw_record_milk")
					.execute("test-call", { amountMl: 120 }),
			/Baby Claw is not initialized/,
		);

		await writeBabyClawState(config, {
			initialized: true,
			network: "testnet",
			packageId: "0xpackage",
			profileId: "0xprofile",
			publishTxDigest: "publish-digest",
			mintTxDigest: "mint-digest",
			imageEncryptionKeyRef: "local",
			createdAt: "2026-05-02T00:00:00.000Z",
		});

		const payloads = [];
		const addRecordInputs = [];
		const tools = createBabyClawTools(config, {
			storeEncryptedJson: async ({ payload }) => {
				payloads.push(payload);
				return createStored(`${payload.type}-blob`, payload.timestampMs);
			},
			addRecord: async (input) => {
				addRecordInputs.push(input);
				return { digest: `tx-${addRecordInputs.length}` };
			},
		});

		const milk = parseToolResult(
			await tools
				.find((tool) => tool.name === "baby_claw_record_milk")
				.execute("test-call", {
					amountMl: 120,
					method: "breast_milk",
					timestampMs: 1_777_603_200_000,
					note: "private note",
				}),
		);
		const sleepStart = parseToolResult(
			await tools
				.find((tool) => tool.name === "baby_claw_sleep_start")
				.execute("test-call", { timestampMs: 1_777_606_800_000 }),
		);
		const sleepEnd = parseToolResult(
			await tools
				.find((tool) => tool.name === "baby_claw_sleep_end")
				.execute("test-call", { timestampMs: 1_777_610_400_000 }),
		);

		assert.deepEqual(
			payloads.map((payload) => payload.type),
			["milk", "sleep_start", "sleep_end"],
		);
		assert.equal(payloads[0].note, "private note");
		assert.equal(milk.type, "milk");
		assert.equal(milk.txDigest, "tx-1");
		assert.equal(sleepStart.type, "sleep_start");
		assert.equal(sleepEnd.type, "sleep_end");
		assert.deepEqual(
			addRecordInputs.map((input) => [
				input.packageId,
				input.profileId,
				input.payloadBlobId,
			]),
			[
				["0xpackage", "0xprofile", "milk-blob"],
				["0xpackage", "0xprofile", "sleep_start-blob"],
				["0xpackage", "0xprofile", "sleep_end-blob"],
			],
		);
	});
});

test("poop tool accepts path images, validates source exclusivity, and hides image bytes", async () => {
	const { createBabyClawTools } = await distImport("dist/tools/step9.js");
	const { writeBabyClawState } = await distImport("dist/state.js");

	await withTempConfig(async (config) => {
		await writeBabyClawState(config, {
			initialized: true,
			network: "testnet",
			packageId: "0xpackage",
			profileId: "0xprofile",
			publishTxDigest: "publish-digest",
			mintTxDigest: "mint-digest",
			imageEncryptionKeyRef: "local",
			createdAt: "2026-05-02T00:00:00.000Z",
		});
		const imagePath = resolve(config.stateDir, "sample.png");
		await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));

		const storedBytes = [];
		const storedJson = [];
		const tools = createBabyClawTools(config, {
			storeEncryptedBytes: async ({ bytes, contentType }) => {
				storedBytes.push({ bytes, contentType });
				return createStored("encrypted-image-blob");
			},
			storeEncryptedJson: async ({ payload }) => {
				storedJson.push(payload);
				return createStored("poop-json-blob", payload.timestampMs);
			},
			addRecord: async () => ({ digest: "poop-digest" }),
		});
		const poopTool = tools.find(
			(tool) => tool.name === "baby_claw_record_poop",
		);

		await assert.rejects(
			() =>
				poopTool.execute("test-call", {
					imageBase64: "AAAA",
					imagePath,
					contentType: "image/png",
				}),
			/exactly one image source/,
		);

		const result = parseToolResult(
			await poopTool.execute("test-call", {
				imagePath,
				timestampMs: 1_777_603_200_000,
				ai: { color: "yellow", warningFlag: false, confidence: 82 },
				note: "private poop note",
			}),
		);
		const serialized = JSON.stringify(result);

		assert.equal(storedBytes[0].contentType, "image/png");
		assert.deepEqual(storedBytes[0].bytes, new Uint8Array([137, 80, 78, 71]));
		assert.equal(storedJson[0].encryptedImageBlobId, "encrypted-image-blob");
		assert.equal(storedJson[0].note, "private poop note");
		assert.equal(result.type, "poop");
		assert.equal(result.imageStored, true);
		assert.equal(serialized.includes("private poop note"), false);
		assert.equal(serialized.includes("137"), false);
	});
});

test("today and last tools decrypt records into sanitized summaries", async () => {
	const { createBabyClawTools } = await distImport("dist/tools/step9.js");
	const { writeBabyClawState } = await distImport("dist/state.js");
	const encoder = new TextEncoder();

	await withTempConfig(async (config) => {
		await writeBabyClawState(config, {
			initialized: true,
			network: "testnet",
			packageId: "0xpackage",
			profileId: "0xprofile",
			publishTxDigest: "publish-digest",
			mintTxDigest: "mint-digest",
			imageEncryptionKeyRef: "local",
			createdAt: "2026-05-02T00:00:00.000Z",
		});

		const payloadByBlob = new Map([
			[
				"milk-blob",
				{
					type: "milk",
					timestampMs: 1_777_603_200_000,
					amountMl: 120,
					method: "formula",
					note: "private milk",
				},
			],
			[
				"sleep-start-blob",
				{ type: "sleep_start", timestampMs: 1_777_606_800_000 },
			],
			["sleep-end-blob", { type: "sleep_end", timestampMs: 1_777_610_400_000 }],
			[
				"poop-blob",
				{
					type: "poop",
					timestampMs: 1_777_614_000_000,
					encryptedImageBlobId: "image-blob",
					ai: { color: "red", warningFlag: true, confidence: 70 },
					note: "private poop",
				},
			],
		]);
		const records = [...payloadByBlob.keys()].map((payloadBlobId, index) => ({
			seq: BigInt(index),
			payloadBlobId,
			payloadHash: new Uint8Array([index]),
			recordCommitment: `commit-${index}`,
			createdAtMs: BigInt(payloadByBlob.get(payloadBlobId).timestampMs),
			schemaVersion: 1,
		}));
		const tools = createBabyClawTools(config, {
			getTodayRecords: async () => records,
			getLastRecord: async () => records.at(-1),
			downloadBlob: async ({ blobId }) =>
				encoder.encode(JSON.stringify(payloadByBlob.get(blobId))),
			decryptEncryptedBlob: async (_config, bytes) => ({
				bytes,
				contentType: "application/json",
				plaintextHash: new Uint8Array([9]),
			}),
		});

		const today = parseToolResult(
			await tools
				.find((tool) => tool.name === "baby_claw_get_today")
				.execute("test-call", {
					date: "2026-05-02",
					timezoneOffsetMinutes: 0,
				}),
		);
		const last = parseToolResult(
			await tools
				.find((tool) => tool.name === "baby_claw_get_last")
				.execute("test-call", {}),
		);
		const serialized = JSON.stringify({ today, last });

		assert.equal(today.date, "2026-05-02");
		assert.equal(today.summary.milkTotalMl, 120);
		assert.equal(today.summary.milkCount, 1);
		assert.equal(today.summary.sleepSessionCount, 1);
		assert.equal(today.summary.poopCount, 1);
		assert.equal(today.summary.poopWarningCount, 1);
		assert.equal(today.records[0].notePresent, true);
		assert.equal(last.record.type, "poop");
		assert.equal(last.record.ai.warningFlag, true);
		assert.equal(serialized.includes("private milk"), false);
		assert.equal(serialized.includes("private poop"), false);
		assert.equal(serialized.includes("image-blob"), false);
	});
});
