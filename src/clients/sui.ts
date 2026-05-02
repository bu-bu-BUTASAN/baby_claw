import { bcs } from "@mysten/sui/bcs";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { Transaction } from "@mysten/sui/transactions";
import {
	type BabyClawContractArtifact,
	babyClawPackageArtifact,
} from "../artifacts/babyClawPackage.js";
import type { BabyClawConfig } from "../config.js";

export { babyClawPackageArtifact };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const clockObjectId = "0x6";

export type SuiNetwork = BabyClawConfig["suiNetwork"];

export type BinaryInput = string | Uint8Array | number[];

export type SuiSigner = {
	toSuiAddress(): string;
	signTransaction?(bytes: Uint8Array): Promise<{ signature: string }>;
};

type TransactionLike = {
	setSender?(sender: string): void;
	publish(input: { modules: string[]; dependencies: string[] }): unknown;
	transferObjects(objects: unknown[], recipient: string): void;
	moveCall(input: { target: string; arguments?: unknown[] }): unknown;
	object:
		| ((objectId: string) => unknown)
		| (((objectId: string) => unknown) & { clock?: () => unknown });
	pure: {
		u64(value: bigint | number | string): unknown;
		vector(kind: "u8", value: number[]): unknown;
	};
};

type CoreApiLike = {
	signAndExecuteTransaction(input: {
		transaction: unknown;
		signer: SuiSigner;
		include?: { effects?: boolean; objectTypes?: boolean };
	}): Promise<unknown>;
	getObject(input: {
		objectId: string;
		include?: { content?: boolean };
	}): Promise<{ object: { objectId?: string; content?: Uint8Array } | null }>;
	listDynamicFields(input: {
		parentId: string;
		cursor?: string | null;
		limit?: number;
	}): Promise<{
		dynamicFields: Array<{ name: { type: string; bcs: Uint8Array } }>;
		hasNextPage?: boolean;
		cursor?: string | null;
	}>;
	getDynamicField(input: {
		parentId: string;
		name: { type: string; bcs: Uint8Array };
	}): Promise<{
		dynamicField: { value: { type: string; bcs: Uint8Array } } | null;
	}>;
};

export type SuiClientLike = {
	core: CoreApiLike;
};

export type SuiClientRuntime = {
	config?: Pick<BabyClawConfig, "suiNetwork" | "suiPrivateKey">;
	client?: SuiClientLike;
	signer?: SuiSigner;
	createTransaction?: () => TransactionLike;
	artifact?: BabyClawContractArtifact;
};

export type PublishUserPackageResult = {
	packageId: string;
	digest: string;
};

export type MintProfileResult = {
	profileId: string;
	digest: string;
};

export type AddRecordInput = SuiClientRuntime & {
	packageId: string;
	profileId: string;
	payloadBlobId: BinaryInput;
	payloadHash: BinaryInput;
	recordCommitment: BinaryInput;
	createdAtMs: bigint | number | string;
};

export type Profile = {
	id: string;
	owner: string;
	nextSeq: bigint;
	schemaVersion: number;
	createdAtMs: bigint;
};

export type BabyClawRecord = {
	seq: bigint;
	payloadBlobId: string;
	payloadHash: Uint8Array;
	recordCommitment: string;
	createdAtMs: bigint;
	schemaVersion: number;
};

export type RecordKey = {
	seq: bigint;
};

export type ProfileLookupInput = SuiClientRuntime & {
	packageId: string;
	profileId: string;
};

export type TodayRecordsInput = ProfileLookupInput & {
	now?: Date;
};

const UidBcs = bcs.struct("UID", {
	id: bcs.Address,
});

export const ProfileBcs = bcs.struct("Profile", {
	id: UidBcs,
	owner: bcs.Address,
	next_seq: bcs.u64(),
	schema_version: bcs.u16(),
	created_at_ms: bcs.u64(),
});

export const RecordKeyBcs = bcs.struct("RecordKey", {
	seq: bcs.u64(),
});

export const RecordBcs = bcs.struct("Record", {
	seq: bcs.u64(),
	payload_blob_id: bcs.vector(bcs.u8()),
	payload_hash: bcs.vector(bcs.u8()),
	record_commitment: bcs.vector(bcs.u8()),
	created_at_ms: bcs.u64(),
	schema_version: bcs.u16(),
});

export function resolveSuiFullnodeUrl(network: SuiNetwork): string {
	switch (network) {
		case "testnet":
			return "https://fullnode.testnet.sui.io:443";
		case "devnet":
			return "https://fullnode.devnet.sui.io:443";
		case "localnet":
			return "http://127.0.0.1:9000";
	}
}

export function createSuiClient(config: Pick<BabyClawConfig, "suiNetwork">) {
	return new SuiGrpcClient({
		network: config.suiNetwork,
		baseUrl: resolveSuiFullnodeUrl(config.suiNetwork),
	});
}

export function createSuiSigner(
	config: Pick<BabyClawConfig, "suiNetwork" | "suiPrivateKey">,
): SuiSigner {
	if (!config.suiPrivateKey) {
		throw new Error("suiPrivateKey is required to sign Sui transactions");
	}

	if (!config.suiPrivateKey.startsWith("suiprivkey")) {
		throw new Error("suiPrivateKey must use the suiprivkey bech32 format");
	}

	try {
		const { scheme, secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);

		switch (scheme) {
			case "ED25519":
				return Ed25519Keypair.fromSecretKey(secretKey);
			case "Secp256k1":
				return Secp256k1Keypair.fromSecretKey(secretKey);
			case "Secp256r1":
				return Secp256r1Keypair.fromSecretKey(secretKey);
			default:
				throw new Error("Unsupported Sui private key scheme");
		}
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "Unsupported Sui private key scheme"
		) {
			throw error;
		}

		throw new Error("Invalid Sui private key; expected suiprivkey format");
	}
}

export async function publishUserPackage(
	input: SuiClientRuntime = {},
): Promise<PublishUserPackageResult> {
	const runtime = resolveRuntime(input);
	const artifact = input.artifact ?? babyClawPackageArtifact;
	const tx = runtime.createTransaction();
	const sender = runtime.signer.toSuiAddress();

	tx.setSender?.(sender);
	const upgradeCap = tx.publish({
		modules: artifact.modules,
		dependencies: artifact.dependencies,
	});
	tx.transferObjects([upgradeCap], sender);

	const result = await executeTransaction(runtime, tx);
	const packageId = extractPublishedPackageId(result);

	if (!packageId) {
		throw new Error("Sui publish transaction is missing published package id");
	}

	return {
		packageId,
		digest: extractDigest(result),
	};
}

export async function mintProfile(
	input: SuiClientRuntime & { packageId: string },
): Promise<MintProfileResult> {
	const runtime = resolveRuntime(input);
	const tx = runtime.createTransaction();
	const sender = runtime.signer.toSuiAddress();

	tx.setSender?.(sender);
	tx.moveCall({
		target: `${input.packageId}::ledger::mint_profile`,
		arguments: [clockObject(tx)],
	});

	const result = await executeTransaction(runtime, tx);
	const profileId = extractCreatedObjectId(
		result,
		`${input.packageId}::ledger::Profile`,
	);

	if (!profileId) {
		throw new Error(
			"Sui mint_profile transaction is missing Profile object id",
		);
	}

	return {
		profileId,
		digest: extractDigest(result),
	};
}

export async function addRecord(
	input: AddRecordInput,
): Promise<{ digest: string }> {
	validateAddRecordInput(input);

	const runtime = resolveRuntime(input);
	const tx = runtime.createTransaction();
	const sender = runtime.signer.toSuiAddress();

	tx.setSender?.(sender);
	tx.moveCall({
		target: `${input.packageId}::ledger::add_record`,
		arguments: [
			tx.object(input.profileId),
			tx.pure.vector("u8", bytesFromInput(input.payloadBlobId)),
			tx.pure.vector("u8", bytesFromInput(input.payloadHash)),
			tx.pure.vector("u8", bytesFromInput(input.recordCommitment)),
			tx.pure.u64(input.createdAtMs),
		],
	});

	const result = await executeTransaction(runtime, tx);

	return { digest: extractDigest(result) };
}

export async function getProfile(input: ProfileLookupInput): Promise<Profile> {
	const runtime = resolveRuntime(input);
	const { object } = await runtime.client.core.getObject({
		objectId: input.profileId,
		include: { content: true },
	});

	if (!object?.content) {
		throw new Error("Sui Profile object is missing BCS content");
	}

	return parseProfile(object.content);
}

export async function listRecords(
	input: ProfileLookupInput,
): Promise<BabyClawRecord[]> {
	const runtime = resolveRuntime(input);
	const recordKeys = await listRecordKeys(runtime.client.core, input.profileId);
	const records: BabyClawRecord[] = [];

	for (const key of recordKeys) {
		const record = await getRecordBySeq(
			runtime.client.core,
			input.packageId,
			input.profileId,
			key.seq,
		);

		if (record) {
			records.push(record);
		}
	}

	return records.sort((a, b) => compareBigInt(a.seq, b.seq));
}

export async function getTodayRecords(
	input: TodayRecordsInput,
): Promise<BabyClawRecord[]> {
	const now = input.now ?? new Date();
	const dayStart = BigInt(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	const dayEnd = dayStart + 86_400_000n;
	const records = await listRecords(input);

	return records.filter(
		(record) => record.createdAtMs >= dayStart && record.createdAtMs < dayEnd,
	);
}

export async function getLastRecord(
	input: ProfileLookupInput,
): Promise<BabyClawRecord | null> {
	const runtime = resolveRuntime(input);
	const profile = await getProfile(input);

	if (profile.nextSeq === 0n) {
		return null;
	}

	return getRecordBySeq(
		runtime.client.core,
		input.packageId,
		input.profileId,
		profile.nextSeq - 1n,
	);
}

export function parseProfile(content: Uint8Array): Profile {
	const parsed = ProfileBcs.parse(content);

	return {
		id: parsed.id.id,
		owner: parsed.owner,
		nextSeq: BigInt(parsed.next_seq),
		schemaVersion: parsed.schema_version,
		createdAtMs: BigInt(parsed.created_at_ms),
	};
}

export function parseRecord(content: Uint8Array): BabyClawRecord {
	const parsed = RecordBcs.parse(content);
	const payloadBlobIdBytes = Uint8Array.from(parsed.payload_blob_id);
	const payloadHash = Uint8Array.from(parsed.payload_hash);
	const recordCommitmentBytes = Uint8Array.from(parsed.record_commitment);

	return {
		seq: BigInt(parsed.seq),
		payloadBlobId: textDecoder.decode(payloadBlobIdBytes),
		payloadHash,
		recordCommitment: textDecoder.decode(recordCommitmentBytes),
		createdAtMs: BigInt(parsed.created_at_ms),
		schemaVersion: parsed.schema_version,
	};
}

export function parseRecordKey(content: Uint8Array): RecordKey {
	const parsed = RecordKeyBcs.parse(content);

	return {
		seq: BigInt(parsed.seq),
	};
}

function resolveRuntime(input: SuiClientRuntime): Required<SuiClientRuntime> {
	const config = input.config;
	const client =
		input.client ??
		(config !== undefined ? (createSuiClient(config) as SuiClientLike) : null);
	const signer =
		input.signer ?? (config !== undefined ? createSuiSigner(config) : null);

	if (!client) {
		throw new Error("Sui client is required");
	}

	if (!signer) {
		throw new Error("Sui signer is required");
	}

	return {
		config: config ?? { suiNetwork: "testnet" },
		client,
		signer,
		createTransaction:
			input.createTransaction ??
			(() => new Transaction() as unknown as TransactionLike),
		artifact: input.artifact ?? babyClawPackageArtifact,
	};
}

async function executeTransaction(
	runtime: Required<SuiClientRuntime>,
	transaction: TransactionLike,
) {
	const result = await runtime.client.core.signAndExecuteTransaction({
		transaction,
		signer: runtime.signer,
		include: { effects: true, objectTypes: true },
	});

	const failed = getFailedTransaction(result);
	if (failed) {
		throw new Error(`Sui transaction failed: ${extractFailureMessage(failed)}`);
	}

	const transactionResult = getSuccessfulTransaction(result);
	if (!transactionResult) {
		throw new Error("Sui transaction returned an empty result");
	}

	return transactionResult;
}

async function listRecordKeys(
	core: CoreApiLike,
	profileId: string,
): Promise<RecordKey[]> {
	const keys: RecordKey[] = [];
	let cursor: string | null | undefined;

	do {
		const page = await core.listDynamicFields({
			parentId: profileId,
			cursor,
		});

		for (const field of page.dynamicFields) {
			keys.push(parseRecordKey(field.name.bcs));
		}

		cursor = page.hasNextPage ? page.cursor : null;
	} while (cursor);

	return keys;
}

async function getRecordBySeq(
	core: CoreApiLike,
	packageId: string,
	profileId: string,
	seq: bigint,
): Promise<BabyClawRecord | null> {
	const response = await core.getDynamicField({
		parentId: profileId,
		name: {
			type: recordKeyType(packageId),
			bcs: RecordKeyBcs.serialize({ seq }).toBytes(),
		},
	});

	if (!response.dynamicField?.value.bcs) {
		return null;
	}

	return parseRecord(response.dynamicField.value.bcs);
}

function recordKeyType(packageId: string): string {
	return `${packageId}::ledger::RecordKey`;
}

function clockObject(tx: TransactionLike): unknown {
	if (typeof tx.object !== "function") {
		throw new Error("Sui transaction builder is missing object helper");
	}

	return "clock" in tx.object && typeof tx.object.clock === "function"
		? tx.object.clock()
		: tx.object(clockObjectId);
}

function bytesFromInput(input: BinaryInput): number[] {
	if (typeof input === "string") {
		return [...textEncoder.encode(input)];
	}

	return [...input];
}

function validateAddRecordInput(input: AddRecordInput): void {
	const checks: Array<[string, BinaryInput]> = [
		["payloadBlobId", input.payloadBlobId],
		["payloadHash", input.payloadHash],
		["recordCommitment", input.recordCommitment],
	];

	for (const [name, value] of checks) {
		if (bytesFromInput(value).length === 0) {
			throw new Error(`${name} is required`);
		}
	}
}

function getSuccessfulTransaction(
	result: unknown,
): Record<string, unknown> | null {
	if (isRecord(result) && isRecord(result.Transaction)) {
		return result.Transaction;
	}

	return null;
}

function getFailedTransaction(result: unknown): Record<string, unknown> | null {
	if (isRecord(result) && isRecord(result.FailedTransaction)) {
		return result.FailedTransaction;
	}

	return null;
}

function extractDigest(transactionResult: Record<string, unknown>): string {
	if (typeof transactionResult.digest === "string") {
		return transactionResult.digest;
	}

	if (
		isRecord(transactionResult.effects) &&
		typeof transactionResult.effects.transactionDigest === "string"
	) {
		return transactionResult.effects.transactionDigest;
	}

	throw new Error("Sui transaction result is missing digest");
}

function extractFailureMessage(failed: Record<string, unknown>): string {
	const status = failed.status;

	if (isRecord(status)) {
		const error = status.error;

		if (typeof error === "string") {
			return error;
		}

		if (isRecord(error) && typeof error.message === "string") {
			return error.message;
		}
	}

	return "unknown error";
}

function extractPublishedPackageId(
	transactionResult: Record<string, unknown>,
): string | null {
	for (const object of extractChangedObjects(transactionResult)) {
		if (isPackageWrite(object)) {
			return extractChangedObjectId(object);
		}
	}

	return null;
}

function extractCreatedObjectId(
	transactionResult: Record<string, unknown>,
	expectedType: string,
): string | null {
	const objectTypes = isRecord(transactionResult.objectTypes)
		? transactionResult.objectTypes
		: {};

	for (const object of extractChangedObjects(transactionResult)) {
		const objectId = extractChangedObjectId(object);

		if (!objectId) {
			continue;
		}

		const objectType =
			(typeof objectTypes[objectId] === "string"
				? objectTypes[objectId]
				: undefined) ?? extractChangedObjectType(object);

		if (objectType === expectedType) {
			return objectId;
		}
	}

	return null;
}

function extractChangedObjects(
	transactionResult: Record<string, unknown>,
): Record<string, unknown>[] {
	if (
		isRecord(transactionResult.effects) &&
		Array.isArray(transactionResult.effects.changedObjects)
	) {
		return transactionResult.effects.changedObjects.filter(isRecord);
	}

	return [];
}

function extractChangedObjectId(
	object: Record<string, unknown>,
): string | null {
	if (typeof object.objectId === "string") {
		return object.objectId;
	}

	if (typeof object.id === "string") {
		return object.id;
	}

	return null;
}

function extractChangedObjectType(
	object: Record<string, unknown>,
): string | null {
	if (typeof object.type === "string") {
		return object.type;
	}

	if (isRecord(object.outputState)) {
		const objectWrite = object.outputState.ObjectWrite;
		if (isRecord(objectWrite) && typeof objectWrite.type === "string") {
			return objectWrite.type;
		}
	}

	return null;
}

function isPackageWrite(object: Record<string, unknown>): boolean {
	if (object.outputState === "PackageWrite") {
		return true;
	}

	if (isRecord(object.outputState)) {
		if ("PackageWrite" in object.outputState) {
			return true;
		}
	}

	return (
		object.type === "package" || extractChangedObjectType(object) === "package"
	);
}

function compareBigInt(a: bigint, b: bigint): number {
	if (a < b) {
		return -1;
	}

	if (a > b) {
		return 1;
	}

	return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
