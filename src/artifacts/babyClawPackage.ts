import artifact from "./baby_claw_package.json" with { type: "json" };

export type BabyClawContractArtifact = {
	modules: string[];
	dependencies: `0x${string}`[];
	sourceHash: `sha256:${string}`;
	contractVersion: string;
};

export const babyClawPackageArtifact = artifact as BabyClawContractArtifact;
