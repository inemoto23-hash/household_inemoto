# 20260811 アップデート予定（予定メモとメール通知）

## 決定事項

| 論点 | 決定 |
|---|---|
| 通知の届き方 | **Azure Communication Services のメール**。Gmail 宛に送る |
| 通知の宛先 | **予定ごとに選ぶ**（自分だけ / 世帯全員） |
| 地図からの店名検索 | **不採用**。日本のデータが実用に耐えないため撤去済み。将来 Google Places を検討 |

## 1. Azure リソース（作成済み）

| リソース | 用途 |
|---|---|
| `inemoto-KakeiFlow-ACS` | メール送信。エンドポイント `https://inemoto-kakeiflow-acs.japan.communication.azure.com` |
| `inemoto-KakeiFlow-Email` + AzureManagedDomain | 差出人 `DoNotReply@b383246d-….azurecomm.net` |

Function App のマネージドIDに **Communication and Email Service Owner** を付与。
**接続文字列もアクセスキーも使わない。** 従来の方針を維持する。

アプリ設定に `ACS_ENDPOINT` / `ACS_SENDER` / `APP_BASE_URL` を追加（いずれも秘密ではない）。

## 2. データベース `009_schedules.sql`

### `schedules`

| 列 | 内容 |
|---|---|
| `scheduled_on` | 対象の日付 |
| `start_minutes` | 0時からの分。終日なら NULL |
| `title` / `detail` | タイトルと詳細メモ |
| `audience` | `creator` / `household` |
| `is_done` | 済みにできる |

> `start_minutes` を分で持つのは、`TIME` 型が node-mssql で 1970-01-01 の Date として返り、
> 取り違えやすいため。金額を `BIGINT` 整数で持つのと同じ判断。

### `schedule_reminders`

予定1件につき通知を複数持てる。`send_at`（UTC）を見て送る。

| 列 | 内容 |
|---|---|
| `offset_minutes` | 予定時刻の何分前か |
| `send_at` | 送信時刻（UTC）。予定の変更時に作り直す |
| `status` | `pending` / `sent` / `failed` / `cancelled` |

**日本時間で組み立てて UTC へ直す。** 終日予定は当日 9:00 を基準時刻とみなす。

## 3. バックエンド

`src/functions/schedules.ts`

| メソッド | ルート |
|---|---|
| GET | `/api/schedules?from=&to=` |
| POST | `/api/schedules` |
| PATCH | `/api/schedules/{id}` |
| DELETE | `/api/schedules/{id}` |

`src/functions/reminders.ts` — **タイマートリガ（5分毎）**。
`send_at <= 現在` かつ `pending` のものを取り出し、ACS でメールを送って `sent` にする。
失敗は `attempts` を増やして残し、3回で `failed` にする。

`src/shared/email.ts` — ACS の REST を叩く薄い層。マネージドIDでトークンを取る。

`calendarMonth` の返却に日別の予定件数を追加する（往復を増やさない）。

## 4. フロントエンド

- カレンダーのセルに**青丸**。祝日の赤丸とは別の位置に置き、**併記**する
- 明細ブロックの下に**予定ブロック**を同じ体裁で置く
- 予定の追加・編集はシート。タイトル / 日付 / 時刻（終日切替）/ 詳細 / 通知 / 宛先
- 通知は複数選択（予定の時刻 / 1時間前 / 3時間前 / 前日）

## 5. 手動作業

なし。ただし初回のメールが迷惑メールに入る可能性があるため、
届かない場合は差出人アドレスを連絡先に追加してもらう。
