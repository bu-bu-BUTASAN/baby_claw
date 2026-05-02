import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const encoder = new TextEncoder();
const PROFILE_ID = `0x${"1".padStart(64, "0")}`;
const OWNER_ID = `0x${"2".padStart(64, "0")}`;

function distImport(relativePath) {
	return import(`${resolve(root, relativePath)}?t=${Date.now()}`);
}

class RecordingTransaction {
	constructor() {
		this.commands = [];
		this.pureValues = [];
		this.objectValues = [];
		this.sender = null;
		this.gas = { $kind: "GasCoin" };
		this.object = (objectId) => {
			if (objectId === "clock") {
				return this.recordObject("clock");
			}
			return this.recordObject(objectId);
		};
		this.object.clock = () => this.recordObject("clock");
		this.pure = {
			u64: (value) => this.recordPure("u64", value),
			vector: (kind, value) => this.recordPure(`vector<${kind}>`, value),
		};
	}

	setSender(sender) {
		this.sender = sender;
	}

	publish(input) {
		const command = {
			kind: "publish",
			modules: input.modules,
			dependencies: input.dependencies,
		};
		this.commands.push(command);
		return { $kind: "Result", Result: this.commands.length - 1 };
	}

	transferObjects(objects, recipient) {
		this.commands.push({ kind: "transferObjects", objects, recipient });
	}

	moveCall(input) {
		this.commands.push({ kind: "moveCall", ...input });
		return { $kind: "Result", Result: this.commands.length - 1 };
	}

	recordPure(type, value) {
		const pure = { $kind: "Pure", type, value };
		this.pureValues.push(pure);
		return pure;
	}

	recordObject(objectId) {
		const object = { $kind: "Object", objectId };
		this.objectValues.push(object);
		return object;
	}
}

function createRuntime(overrides = {}) {
	const transactions = [];
	const executeResults = [...(overrides.executeResults ?? [])];
	const core = {
		signAndExecuteTransaction: async (_input) => {
			return (
				executeResults.shift() ?? {
					Transaction: {
						digest: "tx-digest",
						effects: { changedObjects: [] },
					},
				}
			);
		},
		getObject: async () => ({ object: null }),
		listDynamicFields: async () => ({ dynamicFields: [] }),
		getDynamicField: async () => ({ dynamicField: null }),
		...(overrides.core ?? {}),
	};

	const runtime = {
		config: {
			suiNetwork: "testnet",
			suiPrivateKey: "suiprivkey-test-value",
			...(overrides.config ?? {}),
		},
		client: { core },
		signer: {
			toSuiAddress: () => overrides.sender ?? "0xsender",
		},
		createTransaction: () => {
			const tx = new RecordingTransaction();
			transactions.push(tx);
			return tx;
		},
		...(overrides.runtime ?? {}),
	};

	return { runtime, transactions, core };
}

function changedObject(objectId, type, owner = { AddressOwner: "0xsender" }) {
	return {
		id: objectId,
		outputState: { ObjectWrite: { type } },
		owner,
	};
}

test("publishUserPackage builds a publish transaction and returns the package id", async () => {
	const { publishUserPackage, babyClawPackageArtifact } = await distImport(
		"dist/clients/sui.js",
	);
	const { runtime, transactions } = createRuntime({
		executeResults: [
			{
				Transaction: {
					digest: "publish-digest",
					effects: {
						changedObjects: [
							changedObject("0xupgrade", "0x2::package::UpgradeCap"),
							changedObject("0xpackage", "package"),
						],
					},
				},
			},
		],
	});

	const result = await publishUserPackage(runtime);

	assert.deepEqual(result, {
		packageId: "0xpackage",
		digest: "publish-digest",
	});
	assert.equal(transactions.length, 1);
	assert.deepEqual(transactions[0].commands[0], {
		kind: "publish",
		modules: babyClawPackageArtifact.modules,
		dependencies: babyClawPackageArtifact.dependencies,
	});
	assert.deepEqual(transactions[0].commands[1], {
		kind: "transferObjects",
		objects: [{ $kind: "Result", Result: 0 }],
		recipient: "0xsender",
	});
	assert.equal(transactions[0].sender, "0xsender");
});

test("mintProfile calls ledger::mint_profile and extracts the Profile object id", async () => {
	const { mintProfile } = await distImport("dist/clients/sui.js");
	const { runtime, transactions } = createRuntime({
		executeResults: [
			{
				Transaction: {
					digest: "mint-digest",
					effects: {
						changedObjects: [
							changedObject("0xprofile", "0xpackage::ledger::Profile"),
						],
					},
				},
			},
		],
	});

	const result = await mintProfile({ ...runtime, packageId: "0xpackage" });

	assert.deepEqual(result, { profileId: "0xprofile", digest: "mint-digest" });
	assert.deepEqual(transactions[0].commands[0], {
		kind: "moveCall",
		target: "0xpackage::ledger::mint_profile",
		arguments: [{ $kind: "Object", objectId: "clock" }],
	});
});

test("addRecord builds the add_record Move call with current contract arguments", async () => {
	const { addRecord } = await distImport("dist/clients/sui.js");
	const { runtime, transactions } = createRuntime();

	const result = await addRecord({
		...runtime,
		packageId: "0xpackage",
		profileId: "0xprofile",
		payloadBlobId: "walrus-blob",
		payloadHash: new Uint8Array([1, 2, 3]),
		recordCommitment: "commitment",
		createdAtMs: 1_777_777_777_000,
	});

	assert.deepEqual(result, { digest: "tx-digest" });
	assert.equal(
		transactions[0].commands[0].target,
		"0xpackage::ledger::add_record",
	);
	assert.deepEqual(transactions[0].commands[0].arguments, [
		{ $kind: "Object", objectId: "0xprofile" },
		{
			$kind: "Pure",
			type: "vector<u8>",
			value: [...encoder.encode("walrus-blob")],
		},
		{ $kind: "Pure", type: "vector<u8>", value: [1, 2, 3] },
		{
			$kind: "Pure",
			type: "vector<u8>",
			value: [...encoder.encode("commitment")],
		},
		{ $kind: "Pure", type: "u64", value: 1_777_777_777_000 },
	]);
});

test("profile and record BCS codecs decode Move object content", async () => {
	const {
		ProfileBcs,
		RecordBcs,
		RecordKeyBcs,
		parseProfile,
		parseRecord,
		parseRecordKey,
	} = await distImport("dist/clients/sui.js");

	const profileBytes = ProfileBcs.serialize({
		id: { id: PROFILE_ID },
		owner: OWNER_ID,
		next_seq: 3n,
		schema_version: 1,
		created_at_ms: 1_777_700_000_000n,
	}).toBytes();
	const recordBytes = RecordBcs.serialize({
		seq: 2n,
		payload_blob_id: [...encoder.encode("walrus")],
		payload_hash: [1, 2, 3],
		record_commitment: [...encoder.encode("commit")],
		created_at_ms: 1_777_777_777_000n,
		schema_version: 1,
	}).toBytes();
	const keyBytes = RecordKeyBcs.serialize({ seq: 2n }).toBytes();

	assert.deepEqual(parseProfile(profileBytes), {
		id: PROFILE_ID,
		owner: OWNER_ID,
		nextSeq: 3n,
		schemaVersion: 1,
		createdAtMs: 1_777_700_000_000n,
	});
	assert.deepEqual(parseRecord(recordBytes), {
		seq: 2n,
		payloadBlobId: "walrus",
		payloadHash: new Uint8Array([1, 2, 3]),
		recordCommitment: "commit",
		createdAtMs: 1_777_777_777_000n,
		schemaVersion: 1,
	});
	assert.deepEqual(parseRecordKey(keyBytes), { seq: 2n });
});

test("listRecords, getTodayRecords, and getLastRecord decode dynamic fields", async () => {
	const {
		ProfileBcs,
		RecordBcs,
		RecordKeyBcs,
		getLastRecord,
		getTodayRecords,
		listRecords,
	} = await distImport("dist/clients/sui.js");
	const dayStart = Date.UTC(2026, 4, 2);
	const profileContent = ProfileBcs.serialize({
		id: { id: PROFILE_ID },
		owner: OWNER_ID,
		next_seq: 3n,
		schema_version: 1,
		created_at_ms: BigInt(dayStart),
	}).toBytes();
	const records = new Map(
		[
			[2n, { blob: "two", createdAtMs: BigInt(dayStart + 1_000) }],
			[0n, { blob: "zero", createdAtMs: BigInt(dayStart - 1_000) }],
			[1n, { blob: "one", createdAtMs: BigInt(dayStart + 2_000) }],
		].map(([seq, data]) => [
			seq.toString(),
			RecordBcs.serialize({
				seq,
				payload_blob_id: [...encoder.encode(data.blob)],
				payload_hash: [Number(seq)],
				record_commitment: [...encoder.encode(`commit-${seq}`)],
				created_at_ms: data.createdAtMs,
				schema_version: 1,
			}).toBytes(),
		]),
	);
	const { runtime } = createRuntime({
		core: {
			getObject: async () => ({
				object: {
					objectId: "0xprofile",
					content: profileContent,
				},
			}),
			listDynamicFields: async () => ({
				dynamicFields: [2n, 0n, 1n].map((seq) => ({
					name: {
						type: "0xpackage::ledger::RecordKey",
						bcs: RecordKeyBcs.serialize({ seq }).toBytes(),
					},
				})),
			}),
			getDynamicField: async ({ name }) => {
				const seq = RecordKeyBcs.parse(name.bcs).seq.toString();
				const value = records.get(seq);
				return value
					? {
							dynamicField: {
								value: { type: "0xpackage::ledger::Record", bcs: value },
							},
						}
					: { dynamicField: null };
			},
		},
	});

	const input = { ...runtime, packageId: "0xpackage", profileId: "0xprofile" };

	assert.deepEqual(
		(await listRecords(input)).map((record) => record.seq),
		[0n, 1n, 2n],
	);
	assert.deepEqual(
		(
			await getTodayRecords({ ...input, now: new Date(dayStart + 3_600_000) })
		).map((record) => record.payloadBlobId),
		["one", "two"],
	);
	assert.equal((await getLastRecord(input))?.payloadBlobId, "two");
});

test("Sui client surfaces explicit errors without leaking private keys", async () => {
	const {
		addRecord,
		createSuiSigner,
		getLastRecord,
		mintProfile,
		publishUserPackage,
	} = await distImport("dist/clients/sui.js");

	assert.throws(
		() =>
			createSuiSigner({
				suiNetwork: "testnet",
				suiPrivateKey: "",
			}),
		/suiPrivateKey is required/,
	);
	assert.throws(
		() =>
			createSuiSigner({
				suiNetwork: "testnet",
				suiPrivateKey: "plain-secret-value",
			}),
		/suiprivkey/,
	);

	const failed = createRuntime({
		executeResults: [
			{
				FailedTransaction: {
					status: { error: { message: "Move abort" } },
				},
			},
		],
	});
	await assert.rejects(
		() =>
			addRecord({
				...failed.runtime,
				packageId: "0xpackage",
				profileId: "0xprofile",
				payloadBlobId: "blob",
				payloadHash: "hash",
				recordCommitment: "commit",
				createdAtMs: 1,
			}),
		/Move abort/,
	);

	await assert.rejects(
		() => publishUserPackage(createRuntime().runtime),
		/missing published package id/,
	);
	await assert.rejects(
		() => mintProfile({ ...createRuntime().runtime, packageId: "0xpackage" }),
		/missing Profile object id/,
	);
	await assert.rejects(
		() =>
			addRecord({
				...createRuntime().runtime,
				packageId: "0xpackage",
				profileId: "0xprofile",
				payloadBlobId: "",
				payloadHash: "hash",
				recordCommitment: "commit",
				createdAtMs: 1,
			}),
		/payloadBlobId is required/,
	);

	const emptyProfile = createRuntime({
		core: {
			getObject: async () => ({
				object: {
					objectId: "0xprofile",
					content: (
						await distImport("dist/clients/sui.js")
					).ProfileBcs.serialize({
						id: { id: PROFILE_ID },
						owner: OWNER_ID,
						next_seq: 0n,
						schema_version: 1,
						created_at_ms: 1n,
					}).toBytes(),
				},
			}),
		},
	});
	assert.equal(
		await getLastRecord({
			...emptyProfile.runtime,
			packageId: "0xpackage",
			profileId: "0xprofile",
		}),
		null,
	);
});
