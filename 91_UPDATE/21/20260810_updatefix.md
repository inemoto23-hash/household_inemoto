# 20260810 アップデート完了記録

- **計画書**: [91_UPDATE/01/20260810_rebuild_plan.md](../01/20260810_rebuild_plan.md)
- **予定書**: [91_UPDATE/11/20260810_update.md](../11/20260810_update.md)
- **区分**: Phase 0（基盤構築）完了

## 完了内容

### インフラ

| 対象 | 内容 |
|---|---|
| Azure CLI | 2.89.0 を導入 |
| リソース棚卸し | サブスクリプション `inemoto_KakeiFlow_SS` / RG `inemoto_KakeiFlow_RG` を確認 |
| 誤作成リソース削除 | Japan West 側の Function App・App Service Plan・ストレージ・App Insights の4件 |
| SQL 照合順序 | `SQL_Latin1_General_CP1_CI_AS` → **`Japanese_CI_AS`**（テーブル作成前に実施） |
| SQL 接続経路 | パブリックアクセス有効化 + ファイアウォール開放（Entra 専用認証で保護） |

### 認証・権限（シークレットゼロ構成）

| 対象 | 内容 |
|---|---|
| Entra アプリ登録 | `KakeiFlow-API` / `KakeiFlow-SPA` を作成、スコープ公開、管理者同意付与 |
| アクセストークン | API アプリを **v2**（`requestedAccessTokenVersion: 2`）へ変更 |
| SQL | Function App の MI を包含ユーザーとして登録し `db_datareader` / `db_datawriter` を付与 |
| Key Vault | MI に `Key Vault Secrets User` |
| ストレージ | MI に Blob/Queue/Table のデータロールを付与し、**`allowSharedKeyAccess = false`** |
| CORS | Function App に SWA と localhost を許可 |

**アプリ設定から接続文字列・アカウントキーを完全に排除した。**
残るのは Application Insights の接続文字列（テレメトリ送信専用）のみ。

### データベース

| マイグレーション | 内容 |
|---|---|
| `001_init` | 13テーブル + 2ビュー。台帳4分離、`BIGINT` 円単位整数、`ck_entries_shape` |
| `002_user_invite` | `provider_user_id` を NULL 許容化、招待記録、小遣いを人別に分割 |
| `003_account_priority` | `user_account_priorities` を新設、`default_account_id` を廃止 |
| `004_user_profile` | 絵文字アイコン・色・アバター画像 |

初期マスタとして 世帯1 / カテゴリ13 / 口座13 / プール1 を投入。取引データは移行していない。

### バックエンド

`11_BE_DEPLOYMENT/` を新設し、単独でデプロイ可能にした。

- `GET /api/health`, `GET /api/health/db`, `GET /api/me`
- `GET/POST /api/members`, `PATCH/DELETE /api/members/{id}`
- `GET/PUT/DELETE /api/members/{id}/avatar`
- `PUT /api/members/{id}/account-priorities`
- `GET /api/accounts`

JWT 検証は `jose` + JWKS で行い、Azure の組み込み認証に依存しない。
初回サインイン時は検証済みメールクレームで招待済み行を引き当てて `oid` を紐付ける。

### フロントエンド

- MSAL.js による Entra サインイン
- 疎通確認画面 / プロフィール設定 / メンバー管理
- ライト・ダーク対応のデザイントークン

## 動作確認結果

| 項目 | 結果 |
|---|---|
| SWA 配信・SPA フォールバック | 200 |
| CORS プリフライト | 204 / `Access-Control-Allow-Origin` 正常 |
| MI → Azure SQL 接続 | 成功（`connected_as` = MI の appId、171〜698ms） |
| 共有キー禁止後のデプロイ | 成功（キーを使わずパッケージを配置できる） |
| オーナーのサインイン | 成功 |
| **メンバー招待 → 初回サインインの自動紐付け** | **成功**（招待から約1分で確定） |
| プロフィール・アバター・優先財布 | 動作確認済み |

## 発生した問題と対処

| 問題 | 原因 | 対処 |
|---|---|---|
| サインイン後に `INVALID_TOKEN` | `az ad app create` が既定で **v1 トークン**設定のアプリを作るため、発行者が `sts.windows.net` になり検証に失敗 | API アプリを v2 へ変更。BE を v1/v2 両対応にし、失敗時に実際の `iss`/`aud` を返すよう改善。FE は 401 時に一度だけトークンを強制再取得する |
| 優先財布の保存が `VALIDATION_ERROR` | `node-mssql` が **`BIGINT` を文字列で返す**ため Zod の `z.number()` が弾いた | `db/convert.ts` を新設し API 境界で `number` へ正規化。金額も `BIGINT` のため今後に効く |
| ストレージキーが作業ログに露出 | Function App 作成時に Azure が自動設定した接続文字列を調査中に出力した | MI 方式へ切り替え、**共有キーアクセス自体を禁止**して当該キーを無効化（ローテーション不要） |
| Entra の ID プロバイダー画面が無反応 | `Microsoft.AzureActiveDirectory` リソースプロバイダーが未登録 | 登録実施。あわせて画面を使わない PowerShell 経路と手順書を用意 |

## 残課題

| 項目 | 状態 |
|---|---|
| Google フェデレーション | Google Cloud Console 側の作業待ち。未設定でも Microsoft アカウント経由でサインイン可 |
| 全体リポジトリの push | 保留中（Railway の旧アプリ再デプロイを避けるため） |
| `.claude/skills/` の追跡除外 | 判断待ち（フォント数MBがコミットに含まれている） |
| L2 ドキュメント | Phase 1 で `01_開発ドキュメント/` を整備する |

## 次フェーズ

Phase 1（口座・カテゴリ管理、取引CRUD、カレンダー、その場編集）へ進む。
