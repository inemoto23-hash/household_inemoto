# 11_BE_DEPLOYMENT — KakeiFlow API

Azure Functions（Flex Consumption / Node 22 / TypeScript v4 プログラミングモデル）。
**このフォルダ単独で Function App にデプロイできる。**

## 接続先

| 対象 | 値 |
|---|---|
| Function App | `inemoto-KakeiFlow-FC`（Japan East） |
| エンドポイント | `https://inemoto-kakeiflow-fc-d5bhc0fucggkdnea.japaneast-01.azurewebsites.net` |
| データベース | `inemoto-db-server.database.windows.net` / `KakeiFlow_SQL` |

## 設計上の約束

**接続文字列もAPIキーも保持しない。** Azure SQL・Key Vault へのアクセスはすべて
Function App のシステム割り当てマネージドID（`inemoto-KakeiFlow-FC`）による Entra 認証で行う。
`SQL_SERVER` などのアプリ設定はホスト名にすぎず機密ではない。

認証は Entra が発行した JWT を `jose` で検証する（[src/shared/auth.ts](src/shared/auth.ts)）。
Azure の組み込み認証（EasyAuth）に依存しないため、ホスティング構成を変えても壊れない。

**`householdId` は必ず `withAuth` が返す値を使う。** リクエスト本文に含まれる世帯IDは決して信用しない。

## ディレクトリ

```
src/
├── index.ts            エントリポイント。関数モジュールをここで import する
├── functions/          HTTP トリガ（ルート単位）
├── db/pool.ts          MI でトークンを取得して接続するプール
└── shared/
    ├── auth.ts         JWT 検証 + users 引き当て
    └── http.ts         レスポンス共通形 { data } / { error }
```

## ローカル開発

```bash
cp local.settings.json.example local.settings.json
npm install
az login                 # DefaultAzureCredential がこの資格情報を使う
npm start                # http://localhost:7071
```

ローカルでは自分の Entra アカウントで SQL に接続する。SQL サーバーの
Entra 管理者に設定されている必要がある。

## デプロイ

```bash
npm run deploy
```

`func azure functionapp publish inemoto-KakeiFlow-FC` を実行する。
ビルド（`tsc`）は `deploy` スクリプト内で先に走る。

## エンドポイント

| メソッド | パス | 認証 | 用途 |
|---|---|---|---|
| GET | `/api/health` | 不要 | プロセス生存確認 |
| GET | `/api/health/db` | 不要 | MI 経由の DB 到達確認 |
| GET | `/api/me` | **必要** | トークン検証と世帯メンバー判定 |

## 新しいエンドポイントを追加するとき

1. `src/functions/` にモジュールを作り `app.http(...)` で登録する
2. **`src/index.ts` に import を追加する**（忘れると関数が登録されない）
3. データを扱うものは必ず `withAuth` でラップする
