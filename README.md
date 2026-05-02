<div align="center">

# Baby Claw

**Privacy-first baby care records for OpenClaw, Sui, and Walrus.**

English TL;DR: Baby Claw is an OpenClaw plugin MVP for recording baby care events through chat while keeping sensitive details encrypted off-chain. Sui stores only privacy-neutral verification metadata, and Walrus stores encrypted payloads and images.

![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-4f46e5)
![Sui](https://img.shields.io/badge/Sui-Testnet-00a7e1)
![Walrus](https://img.shields.io/badge/Walrus-Encrypted%20Blobs-14b8a6)
![Privacy](https://img.shields.io/badge/Privacy-First-111827)
![MVP](https://img.shields.io/badge/Hackathon-MVP-f59e0b)

</div>

## 何を作ったか

Baby Claw は、Telegram / OpenClaw から「ミルク120飲んだ」「寝た」「今日のまとめ」のような自然文で育児ログを扱うための、プライバシー重視の OpenClaw Plugin MVP です。

育児記録には、生活リズム、メモ、画像、健康状態を推測できるセンシティブな情報が含まれます。Baby Claw は、詳細データをそのままブロックチェーンへ載せず、**Sui には検証用メタデータだけ**、**Walrus には暗号化済みペイロードだけ**を保存する構成を採ります。

```mermaid
flowchart LR
  parent["Parent<br/>Telegram / OpenClaw"]
  agent["OpenClaw Agent<br/>natural language UX"]
  plugin["Baby Claw Plugin<br/>tools + skill"]
  crypto["Local Encryption<br/>JSON / images"]
  walrus["Walrus<br/>encrypted blobs"]
  sui["Sui<br/>user-owned ledger"]
  state["Local State<br/>packageId / profileId"]

  parent -->|"ミルク120飲んだ"| agent
  agent -->|"tool call"| plugin
  plugin --> crypto
  crypto -->|"encrypted payload"| walrus
  plugin -->|"blob id + hash + commitment"| sui
  plugin --> state

  classDef primary fill:#eef2ff,stroke:#4f46e5,stroke-width:2px,color:#111827;
  classDef secure fill:#ecfdf5,stroke:#10b981,stroke-width:2px,color:#111827;
  classDef chain fill:#eff6ff,stroke:#0284c7,stroke-width:2px,color:#111827;
  class parent,agent,plugin primary;
  class crypto,walrus secure;
  class sui,state chain;
```

## 審査員向けハイライト

| 観点 | Baby Claw の見せどころ |
| --- | --- |
| 体験 | Telegram / OpenClaw から育児ログを自然文で扱う agent-native UX |
| プライバシー | Sui にはミルク量、睡眠詳細、画像、メモを保存しない |
| 分散ストレージ | Walrus に暗号化済み JSON / 画像 blob を保存する設計 |
| 所有権 | `/init` で利用者ごとに Sui Move package を publish する方針 |
| 検証性 | on-chain metadata により改ざん検知や将来の監査導線を確保 |

## デモで見せる体験

最終デモ体験は、親がいつものチャットに短く入力するだけで、記録、保存、確認まで進むことです。

```mermaid
sequenceDiagram
  actor User as Parent
  participant Chat as Telegram / OpenClaw
  participant Plugin as Baby Claw Plugin
  participant Sui as Sui Ledger
  participant Walrus as Walrus

  User->>Chat: /init
  Chat->>Plugin: baby_claw_init
  Plugin->>Sui: publish user package
  Plugin->>Sui: mint Profile object
  Plugin-->>Chat: initialized

  User->>Chat: ミルク120飲んだ
  Chat->>Plugin: baby_claw_record_milk
  Plugin->>Walrus: upload encrypted JSON
  Plugin->>Sui: add_record(blob id, hash, commitment)
  Plugin-->>Chat: 記録しました

  User->>Chat: 今日のまとめ
  Chat->>Plugin: baby_claw_get_today
  Plugin->>Sui: list record metadata
  Plugin->>Walrus: download encrypted payloads
  Plugin-->>Chat: 今日の育児サマリー
```

### 想定入力

```text
/init
ミルク120飲んだ
寝た
起きた
/poop + 画像
今日のまとめ
最後の記録
```

## MVP 実装状況

このリポジトリはハッカソン提出用の MVP です。現時点では、プライバシー重視の土台となる contract / client / storage 層を中心に実装しています。

| 領域 | 状態 | 内容 |
| --- | --- | --- |
| OpenClaw Plugin | 実装済み | `baby_claw_healthcheck`、`baby_claw_status` |
| Config / Local State | 実装済み | private key を返さず、`packageId` / `profileId` を state 管理 |
| Sui Move Contract | 実装済み | `ledger::Profile`、`Record`、Dynamic Field records |
| Move Tests | 実装済み | mint、record追加、owner制御、空 payload 拒否など |
| Runtime Artifact | 実装済み | Plugin から publish するための package artifact |
| Sui Client | 実装済み | publish、mint、add/list/get record の client layer |
| Walrus / Crypto Client | 実装済み | 暗号化 JSON / 画像 blob の保存・復号・tamper拒否 |
| Natural Language Tools | Next | `record_milk`、`sleep_start/end`、`record_poop`、`get_today` |
| Telegram Demo | Next | OpenClaw skill と実ツールをつないだ end-to-end demo |

## なぜ「利用者ごとに publish」するのか

Sui の transaction、object、package、実行タイミングは公開情報です。共有の公式 `packageId` に全ユーザーの育児ログが集まると、利用者同士の行動パターンが関連付けられやすくなります。

Baby Claw では、初回 `/init` で利用者のウォレットから Move package を publish し、その package の下に Profile と Record を作ります。

```mermaid
flowchart TD
  init["/init"]
  publish["User wallet publishes<br/>Baby Claw Move package"]
  mint["Mint Profile object"]
  state["Save packageId / profileId<br/>to local state"]
  ready["Ready to record"]

  init --> publish --> mint --> state --> ready

  shared["Avoid shared packageId<br/>for sensitive family logs"]
  publish -. privacy boundary .-> shared

  classDef action fill:#fff7ed,stroke:#f97316,stroke-width:2px,color:#111827;
  classDef private fill:#fdf2f8,stroke:#db2777,stroke-width:2px,color:#111827;
  class init,publish,mint,state,ready action;
  class shared private;
```

## データ設計

Baby Claw は、公開台帳に出す情報を最小限にします。

```mermaid
flowchart LR
  raw["Private care data<br/>milk, sleep, notes, image"]
  enc["Encrypt locally"]
  blob["Walrus encrypted blob"]
  meta["Sui metadata only<br/>blob id, hash, commitment, seq"]

  raw --> enc --> blob
  blob -->|"opaque reference"| meta

  blocked["Never on-chain<br/>baby name, raw note, image bytes,<br/>milk amount, AI label, diagnosis"]
  raw -. protected from public ledger .-> blocked

  classDef private fill:#fef2f2,stroke:#ef4444,stroke-width:2px,color:#111827;
  classDef encrypted fill:#ecfdf5,stroke:#10b981,stroke-width:2px,color:#111827;
  classDef public fill:#eff6ff,stroke:#0284c7,stroke-width:2px,color:#111827;
  class raw,blocked private;
  class enc,blob encrypted;
  class meta public;
```

| 保存先 | 保存するもの | 保存しないもの |
| --- | --- | --- |
| Sui | `Profile`、sequence、schema version、encrypted blob id、payload hash、record commitment | 赤ちゃんの名前、ミルク量、睡眠詳細、画像、メモ、診断 |
| Walrus | 暗号化済み JSON、暗号化済み画像 | 平文 payload、平文画像、暗号鍵 |
| Local State | `packageId`、`profileId`、tx digest、key reference | private key、raw baby record、復号済み画像 |

## セットアップ

### Requirements

- Bun `1.3.2`
- OpenClaw `2026.4.9`
- Sui CLI: Move contract の build / test を行う場合
- Sui testnet wallet private key
- Walrus publisher / aggregator endpoint

### Install

```bash
bun install
bun run build
bun run test
```

### Contract checks

```bash
bun run build:contract-artifact -- --check
cd contracts && sui move test
```

### OpenClaw config example

```jsonc
{
  "plugins": {
    "baby_claw": {
      "suiNetwork": "testnet",
      "suiPrivateKey": "${SUI_PRIVATE_KEY}",
      "walrusPublisherUrl": "https://publisher.example.com",
      "walrusAggregatorUrl": "https://aggregator.example.com",
      "stateDir": "~/.openclaw/baby_claw",
      "encryptImages": true,
      "walrusEpochs": 1
    }
  }
}
```

### Runtime inspection

```bash
openclaw plugins inspect baby_claw --runtime --json
```

Current registered tools:

```text
baby_claw_healthcheck
baby_claw_status
```

## Repository map

```text
src/
  clients/       Sui, Walrus, and crypto clients
  tools/         OpenClaw tool handlers
  artifacts/     Runtime Move package artifact
contracts/
  sources/       Sui Move ledger module
  tests/         Move tests
skills/
  baby_claw/     OpenClaw skill instructions
tests/           Bun tests for plugin and clients
docs_implement/  MVP implementation plan
```

## Security and privacy notes

- Baby Claw is not a medical device and does not provide medical diagnosis.
- Do not put private keys, encryption keys, raw baby records, image data, or unencrypted notes in logs or chat responses.
- Sui is a public ledger. Even with privacy-neutral metadata, transaction timing, wallet activity, gas usage, and object ownership can be observable.
- Walrus payloads and images must be encrypted before upload.
- The MVP intentionally avoids on-chain function names such as `add_milk` or `add_poop`; records are stored through a generic `add_record` flow.

## Roadmap

```mermaid
gantt
  title Baby Claw MVP Roadmap
  dateFormat  YYYY-MM-DD
  axisFormat  %m/%d
  section Done
  Plugin scaffold and status        :done, a1, 2026-05-02, 1d
  Privacy-first Move ledger         :done, a2, 2026-05-02, 1d
  Runtime artifact and clients      :done, a3, 2026-05-02, 1d
  Encrypted Walrus storage          :done, a4, 2026-05-02, 1d
  section Next
  Init and record tools             :active, b1, 2026-05-03, 1d
  Telegram natural language demo    :b2, after b1, 1d
  End-to-end privacy isolation test :b3, after b2, 1d
```

## License

Hackathon MVP. License file is not included yet.
