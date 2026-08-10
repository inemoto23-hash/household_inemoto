---
name: save-plan
description: "Plan モードで作成したプランを 91_UPDATE/01/ に保存する。ファイル名は YYYYMMDD_XX_plan.md 形式。"
license: MIT
---

# /save-plan — プランの保存

Plan モードで作成したプランを `91_UPDATE/01/` に保存する。

## 実行手順

1. `91_UPDATE/01/` 内の既存ファイルを確認し、本日 (`YYYYMMDD`) の連番 (`XX`) を決定する
   - 例: 本日初のプランなら `01`、2本目なら `02`
2. ファイル名: `YYYYMMDD_XX_plan.md`
3. 以下のテンプレートで保存する

## テンプレート

```markdown
# プラン: YYYYMMDD_XX

## 対象機能・課題


## 実装方針


## タスクリスト
- [ ] タスク1
- [ ] タスク2

## 懸念事項・前提条件


## 承認日時
YYYY-MM-DD HH:MM
```
