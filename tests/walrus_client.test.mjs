import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function distImport(relativePath) {
	return import(`${resolve(root, relativePath)}?t=${Date.now()}`);
}

function createConfig(overrides = {}) {
	return {
		suiNetwork: "testnet",
		stateDir: "/tmp/baby-claw",
		encryptImages: true,
		walrusEpochs: 2,
		walrusPublisherUrl: "https://publisher.example.com",
		walrusAggregatorUrl: "https://aggregator.example.com",
		...overrides,
	};
}

test("walrus client uploads blobs with configured epochs and parses new blob ids", async () => {
	const { uploadBlob } = await distImport("dist/clients/walrus.js");
	const calls = [];

	const blobId = await uploadBlob({
		config: createConfig(),
		bytes: new Uint8Array([1, 2, 3]),
		fetchImpl: async (url, init) => {
			calls.push({ url: url.toString(), init });
			return Response.json({
				newlyCreated: {
					blobObject: {
						blobId: "new-blob-id",
					},
				},
			});
		},
	});

	assert.equal(blobId, "new-blob-id");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://publisher.example.com/v1/blobs?epochs=2");
	assert.equal(calls[0].init.method, "PUT");
	assert.deepEqual(
		new Uint8Array(await calls[0].init.body.arrayBuffer()),
		new Uint8Array([1, 2, 3]),
	);
});

test("walrus client parses already certified blob ids and downloads blob bytes", async () => {
	const { downloadBlob, uploadBlob } = await distImport(
		"dist/clients/walrus.js",
	);

	assert.equal(
		await uploadBlob({
			config: createConfig(),
			bytes: new Uint8Array([9]),
			fetchImpl: async () =>
				Response.json({
					alreadyCertified: {
						blobId: "certified-blob-id",
					},
				}),
		}),
		"certified-blob-id",
	);

	const downloaded = await downloadBlob({
		config: createConfig(),
		blobId: "certified-blob-id",
		fetchImpl: async (url, init) => {
			assert.equal(
				url.toString(),
				"https://aggregator.example.com/v1/blobs/certified-blob-id",
			);
			assert.equal(init?.method, "GET");
			return new Response(new Uint8Array([4, 5, 6]));
		},
	});

	assert.deepEqual(downloaded, new Uint8Array([4, 5, 6]));
});

test("walrus client rejects missing config, empty blobs, failed responses, and malformed success", async () => {
	const { downloadBlob, uploadBlob } = await distImport(
		"dist/clients/walrus.js",
	);

	await assert.rejects(
		() =>
			uploadBlob({
				config: createConfig({ walrusPublisherUrl: undefined }),
				bytes: new Uint8Array([1]),
				fetchImpl: async () => Response.json({}),
			}),
		/walrusPublisherUrl is required/,
	);
	await assert.rejects(
		() =>
			uploadBlob({
				config: createConfig(),
				bytes: new Uint8Array(),
				fetchImpl: async () => Response.json({}),
			}),
		/Walrus upload bytes are required/,
	);
	await assert.rejects(
		() =>
			uploadBlob({
				config: createConfig(),
				bytes: new Uint8Array([1]),
				fetchImpl: async () => new Response("private payload", { status: 500 }),
			}),
		/Walrus upload failed with status 500/,
	);
	await assert.rejects(
		() =>
			uploadBlob({
				config: createConfig(),
				bytes: new Uint8Array([1]),
				fetchImpl: async () => Response.json({}),
			}),
		/Walrus upload response did not include a blob id/,
	);
	await assert.rejects(
		() =>
			downloadBlob({
				config: createConfig({ walrusAggregatorUrl: undefined }),
				blobId: "blob",
				fetchImpl: async () => new Response(),
			}),
		/walrusAggregatorUrl is required/,
	);
});
