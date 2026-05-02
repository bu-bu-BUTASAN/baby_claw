import type { BabyClawConfig } from "../config.js";

type FetchLike = typeof fetch;

type UploadBlobInput = {
	config: Pick<BabyClawConfig, "walrusPublisherUrl" | "walrusEpochs">;
	bytes: Uint8Array;
	fetchImpl?: FetchLike;
};

type DownloadBlobInput = {
	config: Pick<BabyClawConfig, "walrusAggregatorUrl">;
	blobId: string;
	fetchImpl?: FetchLike;
};

function getFetch(fetchImpl?: FetchLike): FetchLike {
	if (fetchImpl) {
		return fetchImpl;
	}
	if (typeof fetch !== "function") {
		throw new Error("fetch is not available");
	}
	return fetch;
}

function buildUrl(baseUrl: string, path: string): URL {
	return new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
}

function requireConfiguredUrl(value: string | undefined, name: string): string {
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function parseBlobId(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}

	const response = value as {
		newlyCreated?: { blobObject?: { blobId?: unknown } };
		alreadyCertified?: { blobId?: unknown };
	};
	const newlyCreatedBlobId = response.newlyCreated?.blobObject?.blobId;
	if (typeof newlyCreatedBlobId === "string" && newlyCreatedBlobId.length > 0) {
		return newlyCreatedBlobId;
	}

	const alreadyCertifiedBlobId = response.alreadyCertified?.blobId;
	if (
		typeof alreadyCertifiedBlobId === "string" &&
		alreadyCertifiedBlobId.length > 0
	) {
		return alreadyCertifiedBlobId;
	}

	return null;
}

export async function uploadBlob({
	config,
	bytes,
	fetchImpl,
}: UploadBlobInput): Promise<string> {
	const publisherUrl = requireConfiguredUrl(
		config.walrusPublisherUrl,
		"walrusPublisherUrl",
	);
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
		throw new Error("Walrus upload bytes are required");
	}

	const url = buildUrl(publisherUrl, "/v1/blobs");
	url.searchParams.set("epochs", String(config.walrusEpochs));
	const body = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(body).set(bytes);
	const response = await getFetch(fetchImpl)(url, {
		method: "PUT",
		body: new Blob([body]),
	});

	if (!response.ok) {
		throw new Error(`Walrus upload failed with status ${response.status}`);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("Walrus upload response was not valid JSON");
	}

	const blobId = parseBlobId(payload);
	if (!blobId) {
		throw new Error("Walrus upload response did not include a blob id");
	}

	return blobId;
}

export async function downloadBlob({
	config,
	blobId,
	fetchImpl,
}: DownloadBlobInput): Promise<Uint8Array> {
	const aggregatorUrl = requireConfiguredUrl(
		config.walrusAggregatorUrl,
		"walrusAggregatorUrl",
	);
	if (!blobId) {
		throw new Error("blobId is required");
	}

	const response = await getFetch(fetchImpl)(
		buildUrl(aggregatorUrl, `/v1/blobs/${encodeURIComponent(blobId)}`),
		{ method: "GET" },
	);
	if (!response.ok) {
		throw new Error(`Walrus download failed with status ${response.status}`);
	}

	return new Uint8Array(await response.arrayBuffer());
}
