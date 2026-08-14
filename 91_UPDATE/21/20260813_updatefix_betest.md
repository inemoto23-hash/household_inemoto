# アップデート済: 2026-08-13 — BE 単体テスト整備（Vitest 導入）

計画書: `91_UPDATE/01/20260813_03_plan.md` ／ 予定書: `91_UPDATE/11/20260813_update_betest.md`

## 実装内容

**BE 初の自動テスト。9ファイル・86テスト、全 green。**

### Phase A — Vitest 導入＋既存純粋関数のテスト（プロダクションコード無変更）

- `vitest` を devDependency に追加（新規依存はこれ1つ）。`npm test` / `npm run test:watch`
- 設定は `vitest.config.mts`（`.ts` だと CommonJS プロジェクトで Vite の設定ローダー警告が出るため `.mts`）
- テストは `test/` 直下。`src/` 配下に置くと tsconfig の include に入り `dist/` へ混入するため。
  `.funcignore` が `test` を除外済みなのでデプロイ物にも入らない
- 対象: `normalizeEntry`（**`ck_entries_shape` のアプリ側鏡像**。カテゴリ⊕プールの排他、
  transfer の両口座・同一口座禁止、種別ごとの強制 null）、`monthRange`、
  `distanceMeters` / `isAtHome` / `dropIfImprecise`（500m 境界）/ `boundingBox`、
  `matchPlace`（**7つの reason 分岐を全網羅**）、`normalizePlaceName` / `displayName`、
  `nextOccurrence`（月末丸め 31日→2/28→3/31、閏年、隔週、endDate）、
  `occurrencesUpTo`（**limit 打ち切り→next から再開で重複しない＝追いつきの冪等性**、skipBefore）、
  `todayJst`（Date 注入）、`scheduleMomentUtc` / `reminderSendAt`（終日 9:00 基準）、
  `num` / `numOrNull`（BIGINT 文字列、throw 分岐）、`fitView`（縮退・クランプ）
- `domain/muni.ts` は定数テーブルのみのため対象外

### Phase B — 挙動不変の抽出（宣言済み優先項目のテスト化）

- **B-1 繰越計算**: `functions/periods.ts` の非 export だった行マッピングを
  `src/domain/period.ts` の純粋関数 `computeCloseLines()` へ抽出。
  `nextMonth` / `prevMonth` / `lastDay` も移動して export。
  `computeLines` は「SQL → 詰め替え → `computeCloseLines`」の合成になった
  （プレビューと実行が同じ関数を通る構造は不変）。
  テストで policy 4種（none / surplus / full=マイナスも渡す / to_pool=正かつ poolId 必須）、
  年跨ぎ、閏年の末日を固定
- **B-2 ゼロサム**: 3箇所に散在していた符号付きペア生成
  （`budgets.ts` 組み換え・プール出し入れ、`periods.ts` 締めの `carry_to_pool`）を
  `src/domain/allocation.ts` の `buildTransferPair()` に一本化。
  **対をここでしか作れない形にして「片側だけ符号が逆」の事故を構造で防ぐ。**
  out は必ず負・in は必ず正・合計は定義上 0。0・負・小数は throw

## 変更ファイル

- `11_BE_DEPLOYMENT/package.json` — vitest 追加、`test` / `test:watch` スクリプト
- `11_BE_DEPLOYMENT/vitest.config.mts` — 新規
- `11_BE_DEPLOYMENT/src/domain/period.ts` — 新規（締め計算の純粋部分）
- `11_BE_DEPLOYMENT/src/domain/allocation.ts` — 新規（ゼロサムペア）
- `11_BE_DEPLOYMENT/src/functions/periods.ts` — 抽出先を呼ぶ形へ（挙動不変）
- `11_BE_DEPLOYMENT/src/functions/budgets.ts` — `buildTransferPair` を使う形へ（挙動不変）
- `11_BE_DEPLOYMENT/test/*.test.ts` — 9本・86テスト

## 確認内容

- [x] `npm test` — 9ファイル・86テスト全 green
- [x] `npm run build` — 通過。`dist/test` が存在しない（テスト混入なし）
- [ ] **締めプレビューの手動スモーク（未・次回デプロイ時）** — Phase B は挙動不変だが
  月次締めの中核を触ったため、次に BE をデプロイしたとき締めプレビューの数字が
  従来と一致することを画面で確認する（締めの実行はしない）

## 残課題

- Phase B の変更はまだ**デプロイされていない**。次回の BE デプロイに同乗させる
  （単独で急ぐ理由はない。デプロイ後に上記スモークを行う）
- DB モックが要るもの（`assertReferencesInHousehold` / `stripIfAtHome` ラッパー /
  `findMissingReferences`）は統合テストの領域として今回スコープ外。
  課金前のセキュリティレビュー（`02_SaaS化引き継ぎ.md` §3）で扱う
- FE のテスト（Playwright E2E）は未着手のまま
