import { constants } from "node:fs";
import {
	access,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BabyClawConfig } from "./config.js";

export type BabyClawState = {
	initialized: true;
	network: string;
	packageId: string;
	profileId: string;
	publishTxDigest: string;
	mintTxDigest: string;
	imageEncryptionKeyRef?: string;
	createdAt: string;
};

const persistedStateKeys = [
	"initialized",
	"network",
	"packageId",
	"profileId",
	"publishTxDigest",
	"mintTxDigest",
	"imageEncryptionKeyRef",
	"createdAt",
] as const;

type PersistedStateKey = (typeof persistedStateKeys)[number];

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

function pickPersistedState(value: Record<string, unknown>): BabyClawState {
	const state: Partial<Record<PersistedStateKey, unknown>> = {};
	for (const key of persistedStateKeys) {
		if (value[key] !== undefined) {
			state[key] = value[key];
		}
	}

	return state as BabyClawState;
}

export function resolveBabyClawStatePath(
	config: Pick<BabyClawConfig, "stateDir">,
): string {
	return resolve(expandHome(config.stateDir), "state.json");
}

export function isInitializedState(
	state: BabyClawState | null | undefined,
): state is BabyClawState {
	return state?.initialized === true;
}

export async function readBabyClawState(
	config: Pick<BabyClawConfig, "stateDir">,
): Promise<BabyClawState | null> {
	const statePath = resolveBabyClawStatePath(config);

	try {
		await access(statePath, constants.F_OK);
	} catch {
		return null;
	}

	const parsed = JSON.parse(await readFile(statePath, "utf8"));
	if (!isRecord(parsed)) {
		throw new Error("Baby Claw state file must contain a JSON object");
	}

	const state = pickPersistedState(parsed);
	if (!isInitializedState(state)) {
		return null;
	}

	return state;
}

export async function writeBabyClawState(
	config: Pick<BabyClawConfig, "stateDir">,
	state: BabyClawState | Record<string, unknown>,
): Promise<void> {
	const statePath = resolveBabyClawStatePath(config);
	const stateDir = dirname(statePath);
	const tempPath = join(
		stateDir,
		`.state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	const persisted = pickPersistedState(state);
	const serialized = `${JSON.stringify(persisted, null, 2)}\n`;

	await mkdir(stateDir, { recursive: true, mode: 0o700 });

	try {
		await writeFile(tempPath, serialized, { mode: 0o600 });
		await rename(tempPath, statePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}
