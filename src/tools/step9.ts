import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Type } from "@sinclair/typebox";
import {
	type DecryptedBlob,
	decryptEncryptedBlob,
	type StoredEncryptedBlob,
	storeEncryptedBytes,
	storeEncryptedJson,
} from "../clients/crypto.js";
import {
	addRecord,
	type BabyClawRecord,
	getLastRecord,
	getTodayRecords,
	listRecords,
	mintProfile,
	publishUserPackage,
} from "../clients/sui.js";
import { downloadBlob, uploadBlob } from "../clients/walrus.js";
import type { BabyClawConfig } from "../config.js";
import {
	type BabyClawState,
	isInitializedState,
	readBabyClawState,
	writeBabyClawState,
} from "../state.js";

const textDecoder = new TextDecoder();
const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxImageBytes = 10 * 1024 * 1024;
const defaultTimezoneOffsetMinutes = 0;

type ToolResponsePayload = Record<string, unknown>;
type Step9ToolResponse = {
	details: ToolResponsePayload;
	content: Array<{ type: "text"; text: string }>;
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

type AddRecordInput = Parameters<typeof addRecord>[0];
type RuntimeInput = {
	config: Pick<BabyClawConfig, "suiNetwork" | "suiPrivateKey">;
};

type Step9Services = {
	publishUserPackage?: typeof publishUserPackage;
	mintProfile?: typeof mintProfile;
	addRecord?: typeof addRecord;
	listRecords?: typeof listRecords;
	getTodayRecords?: typeof getTodayRecords;
	getLastRecord?: typeof getLastRecord;
	storeEncryptedJson?: (
		input: StoreEncryptedJsonInput,
	) => Promise<StoredEncryptedBlob>;
	storeEncryptedBytes?: (
		input: StoreEncryptedBytesInput,
	) => Promise<StoredEncryptedBlob>;
	uploadBlob?: typeof uploadBlob;
	downloadBlob?: typeof downloadBlob;
	decryptEncryptedBlob?: typeof decryptEncryptedBlob;
	fetchImpl?: typeof fetch;
	now?: () => Date;
};

type ResolvedServices = Required<Omit<Step9Services, "fetchImpl">> &
	Pick<Step9Services, "fetchImpl">;

type ToolLike = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (_callId?: string, params?: unknown) => Promise<Step9ToolResponse>;
};

type CarePayload = {
	type: "milk" | "sleep_start" | "sleep_end" | "poop";
	timestampMs: number;
	amountMl?: number;
	method?: string;
	note?: string | null;
	ai?: Record<string, unknown>;
	encryptedImageBlobId?: string;
};

type SanitizedRecord = {
	seq: string;
	type: CarePayload["type"] | "unknown";
	timestampMs: number | null;
	createdAtMs: number;
	schemaVersion: number;
	notePresent: boolean;
	amountMl?: number;
	method?: string;
	imageStored?: boolean;
	ai?: Record<string, unknown>;
};

type ImageInput = {
	bytes: Uint8Array;
	contentType: string;
	source: "base64" | "path" | "url";
};

function resolveServices(services: Step9Services = {}): ResolvedServices {
	return {
		publishUserPackage: services.publishUserPackage ?? publishUserPackage,
		mintProfile: services.mintProfile ?? mintProfile,
		addRecord: services.addRecord ?? addRecord,
		listRecords: services.listRecords ?? listRecords,
		getTodayRecords: services.getTodayRecords ?? getTodayRecords,
		getLastRecord: services.getLastRecord ?? getLastRecord,
		storeEncryptedJson: services.storeEncryptedJson ?? storeEncryptedJson,
		storeEncryptedBytes: services.storeEncryptedBytes ?? storeEncryptedBytes,
		uploadBlob: services.uploadBlob ?? uploadBlob,
		downloadBlob: services.downloadBlob ?? downloadBlob,
		decryptEncryptedBlob: services.decryptEncryptedBlob ?? decryptEncryptedBlob,
		fetchImpl: services.fetchImpl,
		now: services.now ?? (() => new Date()),
	};
}

function toToolResponse(payload: ToolResponsePayload): Step9ToolResponse {
	const text = JSON.stringify(payload, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);

	return {
		details: payload,
		content: [
			{
				type: "text" as const,
				text,
			},
		],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getParams(params: unknown): Record<string, unknown> {
	return isRecord(params) ? params : {};
}

function requireConfigured(config: BabyClawConfig, key: keyof BabyClawConfig) {
	if (!config[key]) {
		throw new Error(`${String(key)} is required`);
	}
}

async function requireInitializedState(
	config: Pick<BabyClawConfig, "stateDir">,
): Promise<BabyClawState> {
	const state = await readBabyClawState(config);
	if (!isInitializedState(state)) {
		throw new Error("Baby Claw is not initialized; run baby_claw_init first");
	}
	return state;
}

function publicStatePayload(state: BabyClawState, created: boolean) {
	return {
		status: "initialized",
		initialized: true,
		created,
		network: state.network,
		packageId: state.packageId,
		profileId: state.profileId,
		publishTxDigest: state.publishTxDigest,
		mintTxDigest: state.mintTxDigest,
		imageEncryptionKeyRef: state.imageEncryptionKeyRef
			? "configured"
			: undefined,
		createdAt: state.createdAt,
	};
}

function optionalTimestampMs(
	params: Record<string, unknown>,
	now: Date,
): number {
	const value = params.timestampMs;
	if (value === undefined) {
		return now.getTime();
	}
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error("timestampMs must be a non-negative safe integer");
	}
	return value;
}

function optionalNote(params: Record<string, unknown>): string | null {
	const value = params.note;
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new Error("note must be a string");
	}
	return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function milkMethod(value: unknown): string {
	if (value === undefined) {
		return "formula";
	}
	if (
		value === "formula" ||
		value === "breast_milk" ||
		value === "direct_breastfeeding" ||
		value === "other"
	) {
		return value;
	}
	throw new Error(
		"method must be formula, breast_milk, direct_breastfeeding, or other",
	);
}

function uploadWithConfig(
	config: BabyClawConfig,
	services: ResolvedServices,
): (bytes: Uint8Array) => Promise<string> {
	return (bytes) => services.uploadBlob({ config, bytes });
}

async function addStoredRecord(
	config: BabyClawConfig,
	state: BabyClawState,
	services: ResolvedServices,
	stored: StoredEncryptedBlob,
): Promise<string> {
	const result = await services.addRecord({
		config,
		packageId: state.packageId,
		profileId: state.profileId,
		payloadBlobId: stored.payloadBlobId,
		payloadHash: stored.payloadHash,
		recordCommitment: stored.recordCommitment,
		createdAtMs: stored.createdAtMs,
	} as AddRecordInput);

	return result.digest;
}

async function recordPayload(
	config: BabyClawConfig,
	services: ResolvedServices,
	payload: CarePayload,
): Promise<StoredEncryptedBlob> {
	return services.storeEncryptedJson({
		config,
		payload,
		uploadBlob: uploadWithConfig(config, services),
		now: new Date(payload.timestampMs),
	});
}

function recordedResponse(
	type: CarePayload["type"],
	stored: StoredEncryptedBlob,
	txDigest: string,
	extra: Record<string, unknown> = {},
) {
	return toToolResponse({
		status: "recorded",
		type,
		timestampMs: stored.createdAtMs,
		txDigest,
		...extra,
	});
}

function createInitTool(
	config: BabyClawConfig,
	services: ResolvedServices,
): ToolLike {
	return {
		name: "baby_claw_init",
		label: "Baby Claw Init",
		description:
			"Publish the user-owned Baby Claw Sui package, mint a Profile, and persist local state.",
		parameters: Type.Object({}),
		async execute() {
			requireConfigured(config, "suiPrivateKey");
			const existing = await readBabyClawState(config);
			if (isInitializedState(existing)) {
				return toToolResponse(publicStatePayload(existing, false));
			}

			const runtime: RuntimeInput = { config };
			const published = await services.publishUserPackage(runtime);
			const minted = await services.mintProfile({
				...runtime,
				packageId: published.packageId,
			});
			const state: BabyClawState = {
				initialized: true,
				network: config.suiNetwork,
				packageId: published.packageId,
				profileId: minted.profileId,
				publishTxDigest: published.digest,
				mintTxDigest: minted.digest,
				imageEncryptionKeyRef: "local",
				createdAt: services.now().toISOString(),
			};

			await writeBabyClawState(config, state);

			return toToolResponse(publicStatePayload(state, true));
		},
	};
}

function createRecordMilkTool(
	config: BabyClawConfig,
	services: ResolvedServices,
): ToolLike {
	return {
		name: "baby_claw_record_milk",
		label: "Baby Claw Record Milk",
		description: "Store an encrypted milk record and add its metadata to Sui.",
		parameters: Type.Object({
			amountMl: Type.Integer({ minimum: 1 }),
			method: Type.Optional(
				Type.Union([
					Type.Literal("formula"),
					Type.Literal("breast_milk"),
					Type.Literal("direct_breastfeeding"),
					Type.Literal("other"),
				]),
			),
			timestampMs: Type.Optional(Type.Integer({ minimum: 0 })),
			note: Type.Optional(Type.String()),
		}),
		async execute(_callId, rawParams) {
			const params = getParams(rawParams);
			const state = await requireInitializedState(config);
			const timestampMs = optionalTimestampMs(params, services.now());
			const payload: CarePayload = {
				type: "milk",
				timestampMs,
				amountMl: requirePositiveInteger(params.amountMl, "amountMl"),
				method: milkMethod(params.method),
				note: optionalNote(params),
			};
			const stored = await recordPayload(config, services, payload);
			const txDigest = await addStoredRecord(config, state, services, stored);

			return recordedResponse("milk", stored, txDigest);
		},
	};
}

function createSleepTool(
	config: BabyClawConfig,
	services: ResolvedServices,
	type: "sleep_start" | "sleep_end",
): ToolLike {
	const label = type === "sleep_start" ? "Sleep Start" : "Sleep End";
	return {
		name: `baby_claw_${type}`,
		label: `Baby Claw ${label}`,
		description: `Store an encrypted ${type} record and add its metadata to Sui.`,
		parameters: Type.Object({
			timestampMs: Type.Optional(Type.Integer({ minimum: 0 })),
			note: Type.Optional(Type.String()),
		}),
		async execute(_callId, rawParams) {
			const params = getParams(rawParams);
			const state = await requireInitializedState(config);
			const timestampMs = optionalTimestampMs(params, services.now());
			const payload: CarePayload = {
				type,
				timestampMs,
				note: optionalNote(params),
			};
			const stored = await recordPayload(config, services, payload);
			const txDigest = await addStoredRecord(config, state, services, stored);

			return recordedResponse(type, stored, txDigest);
		},
	};
}

function sanitizeAi(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const sanitized: Record<string, unknown> = {};
	for (const key of ["color", "consistency"] as const) {
		if (typeof value[key] === "string" && value[key].length <= 64) {
			sanitized[key] = value[key];
		}
	}
	for (const key of ["visibleBlood", "warningFlag"] as const) {
		if (typeof value[key] === "boolean") {
			sanitized[key] = value[key];
		}
	}
	if (
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 100
	) {
		sanitized.confidence = value.confidence;
	}
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function assertAllowedImageType(contentType: string): string {
	const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
	if (!allowedImageTypes.has(normalized)) {
		throw new Error(
			"image contentType must be image/png, image/jpeg, or image/webp",
		);
	}
	return normalized;
}

function inferImageContentType(path: string): string | null {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return null;
	}
}

function assertImageSize(bytes: Uint8Array): void {
	if (bytes.byteLength === 0) {
		throw new Error("image bytes are required");
	}
	if (bytes.byteLength > maxImageBytes) {
		throw new Error("image must be 10MB or smaller");
	}
}

function decodeBase64Image(value: unknown): Uint8Array {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error("imageBase64 must be a non-empty base64 string");
	}
	const normalized = value.trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
		throw new Error("imageBase64 must be a valid base64 string");
	}
	const bytes = new Uint8Array(Buffer.from(normalized, "base64"));
	assertImageSize(bytes);
	return bytes;
}

function isBlockedUrlHost(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	if (
		lower === "localhost" ||
		lower.endsWith(".localhost") ||
		lower.endsWith(".local")
	) {
		return true;
	}
	if (lower === "::1" || lower === "[::1]" || lower === "0.0.0.0") {
		return true;
	}
	if (
		/^127\./.test(lower) ||
		/^10\./.test(lower) ||
		/^192\.168\./.test(lower)
	) {
		return true;
	}
	const match172 = /^172\.(\d+)\./.exec(lower);
	if (match172) {
		const octet = Number(match172[1]);
		return octet >= 16 && octet <= 31;
	}
	return false;
}

async function loadUrlImage(
	urlValue: unknown,
	contentType: string | undefined,
	services: ResolvedServices,
): Promise<ImageInput> {
	if (typeof urlValue !== "string" || urlValue.trim() === "") {
		throw new Error("imageUrl must be a non-empty URL");
	}
	const url = new URL(urlValue);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("imageUrl must use http or https");
	}
	if (isBlockedUrlHost(url.hostname)) {
		throw new Error("imageUrl host is not allowed");
	}
	const fetchImpl = services.fetchImpl ?? fetch;
	const response = await fetchImpl(url, { method: "GET" });
	if (!response.ok) {
		throw new Error(`imageUrl download failed with status ${response.status}`);
	}
	const responseType = response.headers.get("content-type") ?? undefined;
	const normalizedContentType = assertAllowedImageType(
		contentType ?? responseType ?? "",
	);
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > maxImageBytes) {
		throw new Error("image must be 10MB or smaller");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	assertImageSize(bytes);
	return { bytes, contentType: normalizedContentType, source: "url" };
}

async function loadPathImage(
	pathValue: unknown,
	contentType: string | undefined,
): Promise<ImageInput> {
	if (typeof pathValue !== "string" || pathValue.trim() === "") {
		throw new Error("imagePath must be a non-empty path");
	}
	const fileStat = await stat(pathValue);
	if (!fileStat.isFile()) {
		throw new Error("imagePath must point to a file");
	}
	if (fileStat.size > maxImageBytes) {
		throw new Error("image must be 10MB or smaller");
	}
	const normalizedContentType = assertAllowedImageType(
		contentType ?? inferImageContentType(pathValue) ?? "",
	);
	const bytes = new Uint8Array(await readFile(pathValue));
	assertImageSize(bytes);
	return { bytes, contentType: normalizedContentType, source: "path" };
}

async function loadPoopImage(
	params: Record<string, unknown>,
	services: ResolvedServices,
): Promise<ImageInput> {
	const sources = ["imageBase64", "imagePath", "imageUrl"].filter(
		(key) => params[key] !== undefined,
	);
	if (sources.length !== 1) {
		throw new Error("baby_claw_record_poop requires exactly one image source");
	}
	const contentType =
		typeof params.contentType === "string" ? params.contentType : undefined;
	if (params.imageBase64 !== undefined) {
		return {
			bytes: decodeBase64Image(params.imageBase64),
			contentType: assertAllowedImageType(contentType ?? ""),
			source: "base64",
		};
	}
	if (params.imagePath !== undefined) {
		return loadPathImage(params.imagePath, contentType);
	}
	return loadUrlImage(params.imageUrl, contentType, services);
}

function createRecordPoopTool(
	config: BabyClawConfig,
	services: ResolvedServices,
): ToolLike {
	return {
		name: "baby_claw_record_poop",
		label: "Baby Claw Record Poop",
		description:
			"Encrypt a poop image and JSON payload, store them in Walrus, and add metadata to Sui.",
		parameters: Type.Object({
			imageBase64: Type.Optional(Type.String()),
			imagePath: Type.Optional(Type.String()),
			imageUrl: Type.Optional(Type.String({ format: "uri" })),
			contentType: Type.Optional(Type.String()),
			timestampMs: Type.Optional(Type.Integer({ minimum: 0 })),
			note: Type.Optional(Type.String()),
			ai: Type.Optional(Type.Any()),
		}),
		async execute(_callId, rawParams) {
			const params = getParams(rawParams);
			const state = await requireInitializedState(config);
			const timestampMs = optionalTimestampMs(params, services.now());
			const image = await loadPoopImage(params, services);
			const storedImage = await services.storeEncryptedBytes({
				config,
				bytes: image.bytes,
				contentType: image.contentType,
				uploadBlob: uploadWithConfig(config, services),
				now: new Date(timestampMs),
			});
			const payload: CarePayload = {
				type: "poop",
				timestampMs,
				encryptedImageBlobId: storedImage.payloadBlobId,
				note: optionalNote(params),
				...(sanitizeAi(params.ai) ? { ai: sanitizeAi(params.ai) } : {}),
			};
			const stored = await recordPayload(config, services, payload);
			const txDigest = await addStoredRecord(config, state, services, stored);

			return recordedResponse("poop", stored, txDigest, {
				imageStored: true,
				imageSource: image.source,
			});
		},
	};
}

function parseDateParam(
	params: Record<string, unknown>,
	now: Date,
): { date: string; dayStartMs: number; dayEndMs: number } {
	const offsetRaw = params.timezoneOffsetMinutes;
	const timezoneOffsetMinutes =
		offsetRaw === undefined
			? defaultTimezoneOffsetMinutes
			: requireIntegerInRange(
					offsetRaw,
					"timezoneOffsetMinutes",
					-14 * 60,
					14 * 60,
				);
	const dateValue = params.date;
	let date: string;
	if (dateValue === undefined) {
		const shifted = new Date(now.getTime() + timezoneOffsetMinutes * 60_000);
		date = shifted.toISOString().slice(0, 10);
	} else if (
		typeof dateValue === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(dateValue)
	) {
		date = dateValue;
	} else {
		throw new Error("date must use YYYY-MM-DD format");
	}
	const [year, month, day] = date.split("-").map(Number);
	const dayStartMs =
		Date.UTC(year, month - 1, day) - timezoneOffsetMinutes * 60_000;
	return {
		date,
		dayStartMs,
		dayEndMs: dayStartMs + 86_400_000,
	};
}

function requireIntegerInRange(
	value: unknown,
	name: string,
	min: number,
	max: number,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function recordCreatedAtMs(record: BabyClawRecord): number {
	return Number(record.createdAtMs);
}

async function getRecordsForDay(
	config: BabyClawConfig,
	state: BabyClawState,
	services: ResolvedServices,
	params: Record<string, unknown>,
): Promise<{ date: string; records: BabyClawRecord[] }> {
	const bucket = parseDateParam(params, services.now());
	if (services.listRecords !== listRecords) {
		const records = await services.listRecords({
			config,
			packageId: state.packageId,
			profileId: state.profileId,
		});
		return {
			date: bucket.date,
			records: records.filter((record) => {
				const createdAtMs = recordCreatedAtMs(record);
				return (
					createdAtMs >= bucket.dayStartMs && createdAtMs < bucket.dayEndMs
				);
			}),
		};
	}
	if (services.getTodayRecords !== getTodayRecords) {
		return {
			date: bucket.date,
			records: await services.getTodayRecords({
				config,
				packageId: state.packageId,
				profileId: state.profileId,
				now: new Date(bucket.dayStartMs),
			}),
		};
	}
	return {
		date: bucket.date,
		records: await services
			.listRecords({
				config,
				packageId: state.packageId,
				profileId: state.profileId,
			})
			.then((records) =>
				records.filter((record) => {
					const createdAtMs = recordCreatedAtMs(record);
					return (
						createdAtMs >= bucket.dayStartMs && createdAtMs < bucket.dayEndMs
					);
				}),
			),
	};
}

async function decryptRecordPayload(
	config: BabyClawConfig,
	services: ResolvedServices,
	record: BabyClawRecord,
): Promise<CarePayload | null> {
	const encryptedBytes = await services.downloadBlob({
		config,
		blobId: record.payloadBlobId,
	});
	const decrypted = (await services.decryptEncryptedBlob(
		config,
		encryptedBytes,
	)) as DecryptedBlob;
	if (decrypted.contentType !== "application/json") {
		return null;
	}
	const parsed = JSON.parse(textDecoder.decode(decrypted.bytes));
	if (!isRecord(parsed) || typeof parsed.type !== "string") {
		return null;
	}
	return parsed as CarePayload;
}

function sanitizePayloadRecord(
	record: BabyClawRecord,
	payload: CarePayload | null,
): SanitizedRecord {
	const base: SanitizedRecord = {
		seq: record.seq.toString(),
		type: payload?.type ?? "unknown",
		timestampMs:
			typeof payload?.timestampMs === "number" ? payload.timestampMs : null,
		createdAtMs: recordCreatedAtMs(record),
		schemaVersion: record.schemaVersion,
		notePresent: typeof payload?.note === "string" && payload.note.length > 0,
	};
	if (payload?.type === "milk") {
		if (typeof payload.amountMl === "number") {
			base.amountMl = payload.amountMl;
		}
		if (typeof payload.method === "string") {
			base.method = payload.method;
		}
	}
	if (payload?.type === "poop") {
		base.imageStored = Boolean(payload.encryptedImageBlobId);
		if (payload.ai) {
			base.ai = sanitizeAi(payload.ai);
		}
	}
	return base;
}

function summarizeRecords(records: SanitizedRecord[]) {
	const milkRecords = records.filter((record) => record.type === "milk");
	const poopRecords = records.filter((record) => record.type === "poop");
	const sleepSessions = pairSleepSessions(records);

	return {
		recordCount: records.length,
		milkCount: milkRecords.length,
		milkTotalMl: milkRecords.reduce(
			(total, record) => total + (record.amountMl ?? 0),
			0,
		),
		sleepSessionCount: sleepSessions.length,
		sleepTotalMs: sleepSessions.reduce(
			(total, session) => total + (session.durationMs ?? 0),
			0,
		),
		poopCount: poopRecords.length,
		poopWarningCount: poopRecords.filter(
			(record) => record.ai?.warningFlag === true,
		).length,
		sleepSessions,
	};
}

function pairSleepSessions(records: SanitizedRecord[]) {
	const sessions: Array<{
		startTimestampMs: number;
		endTimestampMs?: number;
		durationMs?: number;
	}> = [];
	let openStart: SanitizedRecord | null = null;

	for (const record of records
		.filter(
			(item) =>
				(item.type === "sleep_start" || item.type === "sleep_end") &&
				typeof item.timestampMs === "number",
		)
		.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0))) {
		if (record.type === "sleep_start") {
			openStart = record;
			continue;
		}
		if (
			record.type === "sleep_end" &&
			openStart &&
			typeof openStart.timestampMs === "number"
		) {
			const startTimestampMs = openStart.timestampMs;
			const endTimestampMs = record.timestampMs as number;
			sessions.push({
				startTimestampMs,
				endTimestampMs,
				durationMs: Math.max(0, endTimestampMs - startTimestampMs),
			});
			openStart = null;
		}
	}
	if (openStart?.timestampMs !== null && openStart?.timestampMs !== undefined) {
		sessions.push({ startTimestampMs: openStart.timestampMs });
	}
	return sessions;
}

function createGetTodayTool(
	config: BabyClawConfig,
	services: ResolvedServices,
): ToolLike {
	return {
		name: "baby_claw_get_today",
		label: "Baby Claw Get Today",
		description:
			"Read today's encrypted records and return a sanitized summary.",
		parameters: Type.Object({
			date: Type.Optional(Type.String()),
			timezoneOffsetMinutes: Type.Optional(Type.Integer()),
		}),
		async execute(_callId, rawParams) {
			const params = getParams(rawParams);
			const state = await requireInitializedState(config);
			const { date, records } = await getRecordsForDay(
				config,
				state,
				services,
				params,
			);
			const sanitized: SanitizedRecord[] = [];
			for (const record of records) {
				sanitized.push(
					sanitizePayloadRecord(
						record,
						await decryptRecordPayload(config, services, record),
					),
				);
			}
			sanitized.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));

			return toToolResponse({
				status: "ok",
				date,
				summary: summarizeRecords(sanitized),
				records: sanitized,
			});
		},
	};
}

function createGetLastTool(
	config: BabyClawConfig,
	services: ResolvedServices,
): ToolLike {
	return {
		name: "baby_claw_get_last",
		label: "Baby Claw Get Last",
		description:
			"Read the last encrypted record and return a sanitized summary.",
		parameters: Type.Object({}),
		async execute() {
			const state = await requireInitializedState(config);
			const record = await services.getLastRecord({
				config,
				packageId: state.packageId,
				profileId: state.profileId,
			});
			if (!record) {
				return toToolResponse({
					status: "ok",
					record: null,
				});
			}
			const sanitized = sanitizePayloadRecord(
				record,
				await decryptRecordPayload(config, services, record),
			);

			return toToolResponse({
				status: "ok",
				record: sanitized,
			});
		},
	};
}

export function createBabyClawTools(
	config: BabyClawConfig,
	services?: Step9Services,
): ToolLike[] {
	const resolved = resolveServices(services);
	return [
		createInitTool(config, resolved),
		createRecordMilkTool(config, resolved),
		createSleepTool(config, resolved, "sleep_start"),
		createSleepTool(config, resolved, "sleep_end"),
		createRecordPoopTool(config, resolved),
		createGetTodayTool(config, resolved),
		createGetLastTool(config, resolved),
	];
}
