import { Type } from "@sinclair/typebox";
import type { BabyClawConfig } from "../config.js";
import { isInitializedState, readBabyClawState } from "../state.js";

type StatusPayload =
	| {
			status: "not_initialized";
			initialized: false;
			config: StatusConfigPayload;
	  }
	| {
			status: "initialized";
			initialized: true;
			network: string;
			packageId: string;
			profileId: string;
			publishTxDigest: string;
			mintTxDigest: string;
			imageEncryptionKeyRef?: "configured";
			createdAt: string;
			config: StatusConfigPayload;
	  };

type StatusConfigPayload = {
	hasSuiPrivateKey: boolean;
	hasWalrusPublisherUrl: boolean;
	hasWalrusAggregatorUrl: boolean;
	readyForInit: boolean;
};

function buildConfigPayload(config: BabyClawConfig): StatusConfigPayload {
	const hasSuiPrivateKey = Boolean(config.suiPrivateKey);
	const hasWalrusPublisherUrl = Boolean(config.walrusPublisherUrl);
	const hasWalrusAggregatorUrl = Boolean(config.walrusAggregatorUrl);

	return {
		hasSuiPrivateKey,
		hasWalrusPublisherUrl,
		hasWalrusAggregatorUrl,
		readyForInit:
			hasSuiPrivateKey && hasWalrusPublisherUrl && hasWalrusAggregatorUrl,
	};
}

function toToolResponse(payload: StatusPayload) {
	return {
		details: payload,
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(payload),
			},
		],
	};
}

export function createStatusTool(config: BabyClawConfig) {
	return {
		name: "baby_claw_status",
		label: "Baby Claw Status",
		description: "Return Baby Claw initialization and configuration readiness.",
		parameters: Type.Object({}),
		async execute() {
			const configPayload = buildConfigPayload(config);
			const state = await readBabyClawState(config);

			if (!isInitializedState(state)) {
				return toToolResponse({
					status: "not_initialized",
					initialized: false,
					config: configPayload,
				});
			}

			return toToolResponse({
				status: "initialized",
				initialized: true,
				network: state.network,
				packageId: state.packageId,
				profileId: state.profileId,
				publishTxDigest: state.publishTxDigest,
				mintTxDigest: state.mintTxDigest,
				...(state.imageEncryptionKeyRef
					? { imageEncryptionKeyRef: "configured" as const }
					: {}),
				createdAt: state.createdAt,
				config: configPayload,
			});
		},
	};
}
