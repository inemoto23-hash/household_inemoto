# アップデート予定: 2026-08-13 — BE 単体テスト整備（Vitest 導入）

計画書: `91_UPDATE/01/20260813_03_plan.md`

## 実装予定の内容

- `11_BE_DEPLOYMENT` に Vitest を導入（devDependency 追加はこれ1つ）
- **Phase A（コード無変更）**: `src/domain/` の純粋関数群＋`db/convert.ts`＋`shared/maps.ts:fitView` に
  単体テスト7本（entry / geo / place / recurrence / schedule / convert / maps）
- **Phase B（挙動不変の抽出）**:
  - 月次締めの繰越計算（`functions/periods.ts` 内の行マッピング）を `src/domain/period.ts` へ抽出し、テストで固定
  - ゼロサムペア生成（`budgets.ts` ×2・`periods.ts` ×1 に散在）を `buildTransferPair()` に一本化し、テストで固定

## 影響範囲

- Phase A: 影響なし（テストはビルド外・デプロイ物外。`.funcignore` は `test` 除外済み）
- Phase B: `src/functions/periods.ts`・`src/functions/budgets.ts` の内部構造のみ。
  SQL・トランザクション・API の挙動は不変。反映には BE の再デプロイが必要

## テスト方針

- `npm test`（vitest run）で全 green
- `npm run build` で `dist/` にテスト混入なしを確認
- Phase B 後、締めプレビューの数字が抽出前と一致することを本番画面で手動確認（締め実行はしない）

## ユーザー手動手順

なし（BE 再デプロイのタイミングのみ相談）
