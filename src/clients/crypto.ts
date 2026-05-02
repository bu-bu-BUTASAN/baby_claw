import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BabyClawConfig } from "../config.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const keyBytes = 32;
const nonceBytes = 12;
const encryptionAlgorithm = "AES-256-GCM";
const envelopeSchema = "baby_claw.encrypted_blob.v1";
const localKeyRef = "local";

export type EncryptedBlobEnvelope = {
	schema: typeof envelopeSchema;
	alg: typeof encryptionAlgorithm;
	keyRef: typeof localKeyRef;
	nonce: string;
	authTag: string;
	contentType: string;
	ciphertext: string;
	plaintextSha256: string;
};

export type EncryptedBlob = {
	encryptedBytes: Uint8Array;
	payloadHash: Uint8Array;
	plaintextHash: Uint8Array;
	recordCommitment: string;
	contentType: string;
};

export type DecryptedBlob = {
	bytes: Uint8Array;
	contentType: string;
	plaintextHash: Uint8Array;
};

export type StoredEncryptedBlob = {
	payloadBlobId: string;
	payloadHash: Uint8Array;
	recordCommitment: string;
	createdAtMs: number;
};

type StoreEncryptedJsonInput = {
	config: Pick<BabyClawConfig, "stateDir">;
	payload: unknown;
	uploadBlob: (bytes: Uint8Array) => Promise<string>;
	now?: Date;
};

type StoreEncryptedBytesInput = {
	config: Pick<BabyClawConfig, "stateDir">;
	bytes: Uint8Array;
	contentType: string;
	uploadBlob: (bytes: Uint8Array) => Promise<string>;
	now?: Date;
};

function expandHome(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "base64"));
}

function sha256(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => canonicalize(item));
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
	const serialized = JSON.stringify(canonicalize(value));
	if (serialized === undefined) {
		throw new Error("JSON payload must be serializable");
	}
	return textEncoder.encode(serialized);
}

function getTimestampMs(payload: unknown, now: Date | undefined): number {
	if (
		isRecord(payload) &&
		typeof payload.timestampMs === "number" &&
		Number.isSafeInteger(payload.timestampMs) &&
		payload.timestampMs >= 0
	) {
		return payload.timestampMs;
	}
	return (now ?? new Date()).getTime();
}

async function ensureLocalKey(keyPath: string): Promise<Uint8Array> {
	try {
		const existing = await readFile(keyPath);
		if (existing.byteLength !== keyBytes) {
			throw new Error("Baby Claw encryption key has an invalid length");
		}
		await chmod(keyPath, 0o600);
		return new Uint8Array(existing);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code !== "ENOENT"
		) {
			throw error;
		}
	}

	await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
	const generated = randomBytes(keyBytes);
	try {
		await writeFile(keyPath, generated, { flag: "wx", mode: 0o600 });
		return new Uint8Array(generated);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EEXIST"
		) {
			return ensureLocalKey(keyPath);
		}
		throw error;
	}
}

function assertEncryptedBytesInput(bytes: Uint8Array): void {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
		throw new Error("encrypted blob input is required");
	}
}

function assertContentType(contentType: string): void {
	if (typeof contentType !== "string" || contentType.trim() === "") {
		throw new Error("contentType is required");
	}
}

export function resolveEncryptionKeyPath(
	config: Pick<BabyClawConfig, "stateDir">,
): string {
	return resolve(expandHome(config.stateDir), "keys", "encryption.key");
}

export async function readOrCreateEncryptionKey(
	config: Pick<BabyClawConfig, "stateDir">,
): Promise<Uint8Array> {
	const keyPath = resolveEncryptionKeyPath(config);
	try {
		await access(dirname(keyPath), constants.F_OK);
	} catch {
		await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
	}
	return ensureLocalKey(keyPath);
}

export async function encryptBytes(
	config: Pick<BabyClawConfig, "stateDir">,
	bytes: Uint8Array,
	contentType: string,
): Promise<EncryptedBlob> {
	assertEncryptedBytesInput(bytes);
	assertContentType(contentType);

	const key = await readOrCreateEncryptionKey(config);
	const nonce = randomBytes(nonceBytes);
	const plaintextHash = sha256(bytes);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
	const authTag = cipher.getAuthTag();
	const envelope: EncryptedBlobEnvelope = {
		schema: envelopeSchema,
		alg: encryptionAlgorithm,
		keyRef: localKeyRef,
		nonce: toBase64(nonce),
		authTag: toBase64(authTag),
		contentType,
		ciphertext: toBase64(ciphertext),
		plaintextSha256: hex(plaintextHash),
	};
	const encryptedBytes = textEncoder.encode(JSON.stringify(envelope));

	return {
		encryptedBytes,
		payloadHash: sha256(encryptedBytes),
		plaintextHash,
		recordCommitment: createHmac("sha256", key).update(bytes).digest("hex"),
		contentType,
	};
}

export async function encryptJsonPayload(
	config: Pick<BabyClawConfig, "stateDir">,
	payload: unknown,
	contentType = "application/json",
): Promise<EncryptedBlob> {
	return encryptBytes(config, canonicalJsonBytes(payload), contentType);
}

export async function decryptEncryptedBlob(
	config: Pick<BabyClawConfig, "stateDir">,
	encryptedBytes: Uint8Array,
): Promise<DecryptedBlob> {
	try {
		const envelope = JSON.parse(textDecoder.decode(encryptedBytes));
		if (
			!isRecord(envelope) ||
			envelope.schema !== envelopeSchema ||
			envelope.alg !== encryptionAlgorithm ||
			envelope.keyRef !== localKeyRef ||
			typeof envelope.nonce !== "string" ||
			typeof envelope.authTag !== "string" ||
			typeof envelope.contentType !== "string" ||
			typeof envelope.ciphertext !== "string" ||
			typeof envelope.plaintextSha256 !== "string"
		) {
			throw new Error("invalid envelope");
		}

		const nonce = envelope.nonce as string;
		const authTag = envelope.authTag as string;
		const ciphertext = envelope.ciphertext as string;
		const plaintextSha256 = envelope.plaintextSha256 as string;
		const key = await readOrCreateEncryptionKey(config);
		const decipher = createDecipheriv("aes-256-gcm", key, fromBase64(nonce));
		decipher.setAuthTag(Buffer.from(fromBase64(authTag)));
		const bytes = new Uint8Array(
			Buffer.concat([
				decipher.update(fromBase64(ciphertext)),
				decipher.final(),
			]),
		);
		const plaintextHash = sha256(bytes);
		if (hex(plaintextHash) !== plaintextSha256) {
			throw new Error("hash mismatch");
		}

		return {
			bytes,
			contentType: envelope.contentType,
			plaintextHash,
		};
	} catch {
		throw new Error("Unable to decrypt Baby Claw blob");
	}
}

export async function storeEncryptedJson({
	config,
	payload,
	uploadBlob,
	now,
}: StoreEncryptedJsonInput): Promise<StoredEncryptedBlob> {
	const encrypted = await encryptJsonPayload(config, payload);
	const payloadBlobId = await uploadBlob(encrypted.encryptedBytes);

	return {
		payloadBlobId,
		payloadHash: encrypted.payloadHash,
		recordCommitment: encrypted.recordCommitment,
		createdAtMs: getTimestampMs(payload, now),
	};
}

export async function storeEncryptedBytes({
	config,
	bytes,
	contentType,
	uploadBlob,
	now,
}: StoreEncryptedBytesInput): Promise<StoredEncryptedBlob> {
	const encrypted = await encryptBytes(config, bytes, contentType);
	const payloadBlobId = await uploadBlob(encrypted.encryptedBytes);

	return {
		payloadBlobId,
		payloadHash: encrypted.payloadHash,
		recordCommitment: encrypted.recordCommitment,
		createdAtMs: (now ?? new Date()).getTime(),
	};
}
