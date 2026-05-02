import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function distImport(relativePath) {
	return import(`${resolve(root, relativePath)}?t=${Date.now()}`);
}

async function withTempConfig(fn) {
	const stateDir = await mkdtemp(resolve(tmpdir(), "baby-claw-crypto-"));
	try {
		await fn({
			suiNetwork: "testnet",
			stateDir,
			encryptImages: true,
			walrusEpochs: 1,
		});
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
}

test("crypto client encrypts and decrypts canonical JSON payloads", async () => {
	const { decryptEncryptedBlob, encryptJsonPayload, resolveEncryptionKeyPath } =
		await distImport("dist/clients/crypto.js");

	await withTempConfig(async (config) => {
		const first = await encryptJsonPayload(config, {
			type: "milk",
			amountMl: 120,
			method: "formula",
			note: null,
			timestampMs: 1_777_603_200_000,
		});
		const second = await encryptJsonPayload(config, {
			note: null,
			method: "formula",
			timestampMs: 1_777_603_200_000,
			amountMl: 120,
			type: "milk",
		});

		assert.notDeepEqual(first.encryptedBytes, second.encryptedBytes);
		assert.deepEqual(first.plaintextHash, second.plaintextHash);
		assert.equal(first.recordCommitment, second.recordCommitment);
		assert.equal(first.contentType, "application/json");

		const decrypted = await decryptEncryptedBlob(config, first.encryptedBytes);
		assert.equal(decrypted.contentType, "application/json");
		assert.deepEqual(JSON.parse(new TextDecoder().decode(decrypted.bytes)), {
			amountMl: 120,
			method: "formula",
			note: null,
			timestampMs: 1_777_603_200_000,
			type: "milk",
		});

		const keyPath = resolveEncryptionKeyPath(config);
		const key = await readFile(keyPath);
		const mode = (await stat(keyPath)).mode & 0o777;
		assert.equal(key.byteLength, 32);
		assert.equal(mode, 0o600);
	});
});

test("crypto client encrypts image bytes and rejects tampering or empty blobs", async () => {
	const { decryptEncryptedBlob, encryptBytes, storeEncryptedBytes } =
		await distImport("dist/clients/crypto.js");

	await withTempConfig(async (config) => {
		const imageBytes = new Uint8Array([1, 2, 3, 4, 5]);
		const encrypted = await encryptBytes(config, imageBytes, "image/png");
		const decrypted = await decryptEncryptedBlob(
			config,
			encrypted.encryptedBytes,
		);

		assert.equal(decrypted.contentType, "image/png");
		assert.deepEqual(decrypted.bytes, imageBytes);
		assert.equal(encrypted.payloadHash.byteLength, 32);
		assert.match(encrypted.recordCommitment, /^[0-9a-f]{64}$/);

		const tampered = new Uint8Array(encrypted.encryptedBytes);
		tampered[tampered.length - 3] ^= 1;
		await assert.rejects(
			() => decryptEncryptedBlob(config, tampered),
			/Unable to decrypt Baby Claw blob/,
		);

		await assert.rejects(
			() =>
				storeEncryptedBytes({
					config,
					bytes: new Uint8Array(),
					contentType: "image/png",
					uploadBlob: async () => "blob",
				}),
			/encrypted blob input is required/,
		);
	});
});

test("crypto storage helper returns Step9-ready metadata without exposing plaintext", async () => {
	const { storeEncryptedJson } = await distImport("dist/clients/crypto.js");

	await withTempConfig(async (config) => {
		let uploadedBytes;
		const result = await storeEncryptedJson({
			config,
			payload: {
				type: "sleep_start",
				timestampMs: 1_777_603_200_000,
				note: "private note",
			},
			uploadBlob: async (bytes) => {
				uploadedBytes = bytes;
				return "walrus-blob-id";
			},
			now: new Date("2026-05-02T00:00:00.000Z"),
		});

		assert.equal(result.payloadBlobId, "walrus-blob-id");
		assert.equal(result.createdAtMs, 1_777_603_200_000);
		assert.equal(result.payloadHash.byteLength, 32);
		assert.match(result.recordCommitment, /^[0-9a-f]{64}$/);
		assert.equal(
			new TextDecoder().decode(uploadedBytes).includes("private note"),
			false,
		);
	});
});
