import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skillPath = resolve(root, "skills/baby_claw/SKILL.md");

async function readSkill() {
	return readFile(skillPath, "utf8");
}

function frontmatterOf(markdown) {
	const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
	assert.ok(match, "expected SKILL.md to have YAML frontmatter");
	return match[1];
}

test("baby_claw skill exposes Step 10 metadata and all allowed tools", async () => {
	const skill = await readSkill();
	const frontmatter = frontmatterOf(skill);
	const requiredTools = [
		"baby_claw_init",
		"baby_claw_status",
		"baby_claw_record_milk",
		"baby_claw_sleep_start",
		"baby_claw_sleep_end",
		"baby_claw_record_poop",
		"baby_claw_get_today",
		"baby_claw_get_last",
	];

	assert.match(frontmatter, /^name:\s*baby_claw$/m);
	assert.match(frontmatter, /^user-invocable:\s*true$/m);
	assert.match(frontmatter, /description:.*\/init/);
	assert.match(frontmatter, /description:.*ミルク/);
	assert.match(frontmatter, /description:.*睡眠/);
	assert.match(frontmatter, /description:.*うんち画像/);
	assert.match(frontmatter, /description:.*今日のまとめ/);
	assert.match(frontmatter, /description:.*最後の記録/);
	assert.equal(frontmatter.includes("command-dispatch"), false);

	for (const tool of requiredTools) {
		assert.match(frontmatter, new RegExp(`"${tool}"`));
	}
});

test("baby_claw skill documents natural language routing rules", async () => {
	const skill = await readSkill();

	for (const phrase of [
		"/init",
		"初期設定",
		"はじめる",
		"/init はる",
		"名前部分は保存しない",
		"ミルク120飲んだ",
		"120ml飲んだ",
		"amountMl",
		"母乳",
		"搾母乳",
		"直母",
		"寝た",
		"寝ました",
		"就寝",
		"起きた",
		"起床",
		"目が覚めた",
		"/poop",
		"うんち",
		"画像 source が1つ",
		"今日のまとめ",
		"YYYY-MM-DD",
		"timezoneOffsetMinutes",
		"最後の記録",
	]) {
		assert.match(
			skill,
			new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	}
});

test("baby_claw skill includes privacy, medical, and response safety rules", async () => {
	const skill = await readSkill();

	for (const phrase of [
		"private key",
		"暗号鍵",
		"平文メモ",
		"画像 bytes",
		"local path",
		"raw payload",
		"医療診断はしない",
		"赤",
		"黒",
		"白",
		"灰色",
		"小児科相談",
		"/init を案内",
		"tool の JSON をそのまま貼らない",
		"tx digest",
	]) {
		assert.match(
			skill,
			new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	}
});
