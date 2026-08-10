---
name: patch-note
description: "リリース・バージョンアップ時に 91_UPDATE/41/ へパッチノートを作成する。ファイル名は YYYYMMDD_X_X_X_X_patchnote.md 形式。"
license: MIT
---

# /patch-note — パッチノートの作成

リリース・バージョンアップ時に `91_UPDATE/41/` へパッチノートを作成する。

## ファイル名規則

`YYYYMMDD_X_X_X_X_patchnote.md`
- `X_X_X_X` = バージョン番号（例: `1_0_0_0` → v1.0.0.0）
- メジャー_マイナー_パッチ_ビルド

## 実行手順

1. `91_UPDATE/21/` の最新 `update_fix.md` を確認し、変更内容を集約する
2. `91_UPDATE/31/` の `update_future.md` を確認し、残課題を記載する
3. 以下テンプレートで `91_UPDATE/41/YYYYMMDD_X_X_X_X_patchnote.md` を作成する

## テンプレート

```markdown
# パッチノート vX.X.X.X — YYYY-MM-DD

## 新機能
- 

## 変更・改善
- 

## バグ修正
- 

## 既知の問題・今後の予定
- 

## 変更ファイル一覧
| ファイル | 変更種別 |
|---------|---------|
| `path/to/file.py` | 追加 / 変更 / 削除 |
```
