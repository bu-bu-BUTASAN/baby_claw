---
name: baby_claw
description: /init、ミルク、睡眠、うんち画像、今日のまとめ、最後の記録を Baby Claw tools に安全にルーティングする。
user-invocable: true
allowed-tools: ["baby_claw_init", "baby_claw_status", "baby_claw_record_milk", "baby_claw_sleep_start", "baby_claw_sleep_end", "baby_claw_record_poop", "baby_claw_get_today", "baby_claw_get_last"]
---

# Baby Claw

Use this skill when the user wants to operate Baby Claw from Telegram or OpenClaw chat with short natural-language baby care messages. Route the user's intent to the Baby Claw tool directly when the required fields are clear. Ask one short clarification only when a required field is missing.

## Routing

- `/init`, `初期設定`, `はじめる`: call `baby_claw_init` with `{}`. For messages like `/init はる`, treat the text after `/init` as conversational context only; 名前部分は保存しない.
- Status or readiness checks: call `baby_claw_status`.
- `ミルク120飲んだ`, `120ml飲んだ`, or similar milk messages: extract the positive integer amount into `amountMl` and call `baby_claw_record_milk`.
- Milk `method`: set it only when the user is explicit. Use `formula` for formula, `breast_milk` for 母乳 or 搾母乳, `direct_breastfeeding` for 直母, and `other` for other clearly stated methods.
- If a milk message has no amount, ask for the ml amount before calling `baby_claw_record_milk`.
- `寝た`, `寝ました`, `就寝`: call `baby_claw_sleep_start`.
- `起きた`, `起床`, `目が覚めた`: call `baby_claw_sleep_end`.
- `/poop + 画像`, `うんち + 画像`, or poop messages with an attached image: call `baby_claw_record_poop` only when exactly one image source is available. 画像 source が1つではない、または画像がない場合は添付を依頼する.
- `今日のまとめ`: call `baby_claw_get_today`. If the user gives a date, pass `date` in `YYYY-MM-DD` format. Pass `timezoneOffsetMinutes` only when the user's timezone offset is explicit.
- `最後の記録`: call `baby_claw_get_last`.

## Parameters

- For record tools, pass `timestampMs` only when the user gave a clear time that can be converted reliably; otherwise let the tool use the current time.
- Put short user notes in `note` only when the user clearly intends the text as a private note. Never invent notes.
- For poop records, pass exactly one supported image input from the channel/tool context: `imageBase64`, `imagePath`, or `imageUrl`, plus `contentType` when known.
- Do not infer a baby name, profile name, or family member from `/init` arguments or casual text.

## Safety And Privacy

- Never reveal or repeat private key values, encryption keys, 暗号鍵, 平文メモ, image bytes, 画像 bytes, local path values, raw payload content, raw baby records, unencrypted notes, or image data.
- Do not paste raw tool output. tool の JSON をそのまま貼らない.
- If a tool says Baby Claw is not initialized or requires initialization, /init を案内 and stop after that guidance.
- Do not make medical diagnoses. 医療診断はしない.
- If the user mentions or the available observation clearly indicates 赤, 黒, 白, or 灰色 poop, do not diagnose; gently recommend 小児科相談.
- Do not claim to inspect, diagnose, or classify an image beyond the safe fields already returned by the tool.

## Replies

- On successful record creation, reply briefly that it was recorded. Use wording like `記録しました`.
- For `今日のまとめ`, reply with a short human summary beginning with `今日のまとめです`.
- For `最後の記録`, summarize the sanitized record only.
- tx digest may be included only when it helps the user verify the operation; keep it short and never include secrets or plaintext payloads.
