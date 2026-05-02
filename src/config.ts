import { Type } from "@sinclair/typebox";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

const defaultSuiNetwork = "testnet";
const defaultStateDir = "~/.openclaw/baby_claw";
const defaultEncryptImages = true;
const allowedSuiNetworks = new Set(["testnet", "devnet", "localnet"]);

export type BabyClawConfig = {
	suiNetwork: "testnet" | "devnet" | "localnet";
	suiPrivateKey?: string;
	walrusPublisherUrl?: string;
	walrusAggregatorUrl?: string;
	stateDir: string;
	encryptImages: boolean;
};

export const configJsonSchema = Type.Object(
	{
		suiNetwork: Type.Optional(
			Type.Union([
				Type.Literal("testnet"),
				Type.Literal("devnet"),
				Type.Literal("localnet"),
			]),
		),
		suiPrivateKey: Type.Optional(Type.String()),
		walrusPublisherUrl: Type.Optional(Type.String({ format: "uri" })),
		walrusAggregatorUrl: Type.Optional(Type.String({ format: "uri" })),
		stateDir: Type.Optional(Type.String()),
		encryptImages: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const configUiHints = {
	suiPrivateKey: {
		label: "Sui private key",
		sensitive: true,
	},
} satisfies NonNullable<OpenClawPluginConfigSchema["uiHints"]>;

type ValidationResult =
	| {
			ok: true;
			value: BabyClawConfig;
	  }
	| {
			ok: false;
			errors: string[];
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidUrl(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

export function validateBabyClawConfig(value: unknown): ValidationResult {
	const errors: string[] = [];

	if (!isRecord(value)) {
		return {
			ok: false,
			errors: ["config must be an object"],
		};
	}

	const allowedKeys = new Set(Object.keys(configJsonSchema.properties));
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			errors.push(`${key} is not a supported Baby Claw config field`);
		}
	}

	if (
		value.suiNetwork !== undefined &&
		(typeof value.suiNetwork !== "string" ||
			!allowedSuiNetworks.has(value.suiNetwork))
	) {
		errors.push("suiNetwork must be testnet, devnet, or localnet");
	}

	if (
		value.suiPrivateKey !== undefined &&
		typeof value.suiPrivateKey !== "string"
	) {
		errors.push("suiPrivateKey must be a string");
	}

	if (value.stateDir !== undefined && typeof value.stateDir !== "string") {
		errors.push("stateDir must be a string");
	}

	if (
		value.encryptImages !== undefined &&
		typeof value.encryptImages !== "boolean"
	) {
		errors.push("encryptImages must be a boolean");
	}

	for (const key of ["walrusPublisherUrl", "walrusAggregatorUrl"] as const) {
		const url = value[key];
		if (url !== undefined) {
			if (typeof url !== "string") {
				errors.push(`${key} must be a string URL`);
			} else if (!isValidUrl(url)) {
				errors.push(`${key} must be a valid URL`);
			}
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		value: {
			suiNetwork: (value.suiNetwork ??
				defaultSuiNetwork) as BabyClawConfig["suiNetwork"],
			stateDir: (value.stateDir ?? defaultStateDir) as string,
			encryptImages: (value.encryptImages ?? defaultEncryptImages) as boolean,
			...(value.suiPrivateKey !== undefined
				? { suiPrivateKey: value.suiPrivateKey as string }
				: {}),
			...(value.walrusPublisherUrl !== undefined
				? { walrusPublisherUrl: value.walrusPublisherUrl as string }
				: {}),
			...(value.walrusAggregatorUrl !== undefined
				? { walrusAggregatorUrl: value.walrusAggregatorUrl as string }
				: {}),
		},
	};
}

export function normalizeBabyClawConfig(value: unknown): BabyClawConfig {
	const result = validateBabyClawConfig(value);

	if (!result.ok) {
		throw new Error(`Invalid Baby Claw config: ${result.errors.join("; ")}`);
	}

	return result.value;
}

export const configSchema: OpenClawPluginConfigSchema = {
	jsonSchema: configJsonSchema,
	uiHints: configUiHints,
	validate(value) {
		const result = validateBabyClawConfig(value);
		if (!result.ok) {
			return result;
		}
		return {
			ok: true,
			value: result.value,
		};
	},
	parse(value) {
		return normalizeBabyClawConfig(value);
	},
	safeParse(value) {
		const result = validateBabyClawConfig(value);
		if (result.ok) {
			return {
				success: true,
				data: result.value,
			};
		}

		return {
			success: false,
			error: {
				issues: result.errors.map((message) => ({
					path: [],
					message,
				})),
			},
		};
	},
};
