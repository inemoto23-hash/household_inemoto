---
name: doc-check
description: "実装着手前・実装完了後にコアドキュメントを確認・更新する。system_architecture.md と file_map.md の読み込み・差分検出・更新を行う。"
license: MIT
---

# /doc-check — ドキュメント確認・更新

実装着手前と実装完了後に必ず実行する。

## 実行手順

### 着手前
1. `90_DOCUMENT/system_architecture.md` を読み込む
2. `90_DOCUMENT/file_map.md` を読み込む
3. 今回の実装内容と照合し、**差分・矛盾・未記載事項** があればユーザーに報告する

### 完了後
1. `system_architecture.md` — モジュール追加・依存関係変更・制約変更があれば更新
2. `file_map.md` — ファイル追加・削除・移動があれば更新。「実装済みファイル一覧」テーブルへ追記
3. 両ファイル末尾の `*最終更新: YYYY-MM-DD*` を本日日付に書き換える
4. 削除・移動したファイルは一覧から除去する（コメントアウト不可）
