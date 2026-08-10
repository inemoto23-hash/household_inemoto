---
name: update-log
description: "実装前後のアップデートログを 91_UPDATE/ 配下に記録する。予定書(11/)・済項目(21/)・後回し(31/) の3種類を管理する。"
license: MIT
---

# /update-log — アップデートログの記録

## フォルダ・ファイルの対応

| フォルダ | ファイル名 | 用途 |
|---------|-----------|------|
| `91_UPDATE/11/` | `YYYYMMDD_update.md` | アップデート予定書（実装前に記述） |
| `91_UPDATE/21/` | `YYYYMMDD_update_fix.md` | アップデート済項目（実装後に記述） |
| `91_UPDATE/31/` | `YYYYMMDD_update_future.md` | 後回しにした項目（判断時に記述） |

## 実行手順

### 実装前（予定書）
1. `91_UPDATE/11/YYYYMMDD_update.md` を作成
2. 実装予定の内容・影響範囲・テスト方針を記述

### 実装後（済項目）
1. `91_UPDATE/21/YYYYMMDD_update_fix.md` を作成または追記
2. 実装済みの内容・変更ファイル・確認結果を記述

### 後回し判断時
1. `91_UPDATE/31/YYYYMMDD_update_future.md` に追記
2. 後回しの理由・優先度・再検討タイミングを記述

## テンプレート（update_fix）

```markdown
# アップデート済: YYYY-MM-DD

## 実装内容


## 変更ファイル
- `path/to/file.py` — 変更概要

## 確認内容
- [ ] サブエージェントレビュー完了
- [ ] テスト通過
- [ ] /doc-check 実行済み
```
