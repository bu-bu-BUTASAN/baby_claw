import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

async function readJson(relativePath) {
  const file = resolve(root, relativePath);
  return JSON.parse(await readFile(file, "utf8"));
}

test("openclaw manifest declares baby_claw with an empty config schema", async () => {
  const manifestPath = resolve(root, "openclaw.plugin.json");

  assert.equal(existsSync(manifestPath), true);

  const manifest = await readJson("openclaw.plugin.json");

  assert.equal(manifest.id, "baby_claw");
  assert.deepEqual(manifest.configSchema, {
    type: "object",
    additionalProperties: false,
    properties: {},
  });
});

test("openclaw manifest declares the healthcheck tool contract and skill root", async () => {
  const manifest = await readJson("openclaw.plugin.json");

  assert.deepEqual(manifest.skills, ["skills/baby_claw"]);
  assert.deepEqual(manifest.contracts?.tools, ["baby_claw_healthcheck"]);
});

test("package metadata exposes OpenClaw dev and runtime entries", async () => {
  const packageJson = await readJson("package.json");

  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.scripts?.build, "tsc -p tsconfig.json");
  assert.equal(packageJson.scripts?.test, "node --test tests/*.test.mjs");
  assert.deepEqual(packageJson.openclaw?.extensions, ["./src/index.ts"]);
  assert.deepEqual(packageJson.openclaw?.runtimeExtensions, ["./dist/index.js"]);
});

test("compiled plugin entry registers the baby_claw_healthcheck tool", async () => {
  const entryPath = resolve(root, "dist/index.js");

  assert.equal(existsSync(entryPath), true, "expected npm run build to create dist/index.js");

  const { default: entry } = await import(`${entryPath}?t=${Date.now()}`);
  const registeredTools = [];
  const api = {
    registerTool(tool, options) {
      registeredTools.push({ tool, options });
    },
  };

  assert.equal(entry.id, "baby_claw");
  assert.equal(typeof entry.register, "function");

  entry.register(api);

  assert.equal(registeredTools.length, 1);

  const [{ tool, options }] = registeredTools;

  assert.equal(tool.name, "baby_claw_healthcheck");
  assert.equal(options, undefined);
  assert.equal(tool.parameters?.type, "object");

  const result = await tool.execute("test-call", {});
  const text = result.content?.[0]?.text;

  assert.equal(result.content?.[0]?.type, "text");
  assert.deepEqual(JSON.parse(text), {
    ok: true,
    plugin: "baby_claw",
    version: "0.1.0",
  });
});
