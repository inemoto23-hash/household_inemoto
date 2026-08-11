# 20260811 アップデート完了記録（予定メモとメール通知 / Azure Maps 撤去）

- **予定書**: [91_UPDATE/11/20260811_update_schedule.md](../11/20260811_update_schedule.md)

## 1. Azure Maps の撤去

実測の結果、**日本のデータが用途に耐えなかった**ため採用を取りやめ、リソースごと削除した。

| 計測地点 | 半径200〜250mで見つかった施設 |
|---|---|
| 渋谷 道玄坂 | `Shibuya Tokyu Inn`（ホテル）、`Shibuya-eki`（駅）の2件のみ |
| 東京駅前 | `Tōkyō`（駅）、ホテル3件 |
| 大阪駅前 | `Ōsaka`（駅）、EV充電スタンド1件 |

**コンビニ・スーパー・飲食店が1件も出ない。** 家計簿で実際に使う店が入っていない。
名前もローマ字で、`language=ja` / `ja-JP` / `NGT` / `NEUTRAL` のいずれでも日本語にならなかった。

住所の逆引き（`reverseGeocode` api-version 2025-01-01）は丁目まで出るが、これもローマ字。

削除したもの: Maps アカウント、`MAPS_CLIENT_ID` アプリ設定、`functions/places.ts`、FE の「地図から探す」。

**「過去の記録から」の候補（`/api/places/nearby`）は残す。** よく行く店は数十件で頭打ちになるため、
最初の1回だけ手入力すれば以降は自動で埋まる。

> 将来の選択肢として Google Places を記録に残す。日本の店名は正確に出るが API キーが必要。
> Key Vault に置いて MI で読む形なら、当初の「機密保存場所は Key Vault」という設計の範囲に収まる。

## 2. 予定メモ

### Azure リソース

| リソース | 用途 |
|---|---|
| `inemoto-KakeiFlow-ACS` | メール送信。`https://inemoto-kakeiflow-acs.japan.communication.azure.com` |
| `inemoto-KakeiFlow-Email` / AzureManagedDomain | 差出人 `DoNotReply@b383246d-….azurecomm.net` |

Function App の MI に **Communication and Email Service Owner**。
**接続文字列もアクセスキーも使わない。** アプリ設定は `ACS_ENDPOINT` / `ACS_SENDER` / `APP_BASE_URL`（いずれも秘密ではない）。

### データベース

- `009_schedules.sql` — `schedules` / `schedule_reminders`
- `010_reminder_claim.sql` — `sending` 状態と `claimed_at`

`start_minutes` を分（SMALLINT）で持つのは、`TIME` 型が node-mssql で 1970-01-01 の Date として返り
取り違えやすいため。金額を `BIGINT` 整数で持つのと同じ判断。

### バックエンド

| メソッド | ルート |
|---|---|
| GET / POST | `/api/schedules` |
| PATCH / DELETE | `/api/schedules/{id}` |

`functions/reminders.ts` — **5分ごとのタイマー**。

- 取り出しと同時に `sending` へ変え、**同じ予約を2回処理しない**
- 送信中に落ちたものは15分後に拾い直す（`claimed_at`）
- 失敗は3回まで再試行
- 送信予定から12時間以上過ぎたものは送らない（復旧時に古い通知が大量に飛ぶのを防ぐ）

`domain/schedule.ts` — 時刻の計算を純粋関数に切り出した。
通知の時刻計算は「来ない」「夜中に来る」という形でしか誤りに気付けないため、単体で確かめられる形にしてある。
**終日の予定は当日9:00を基準**とする（前日通知が真夜中に飛ばないように）。

`calendarMonth` に日別の予定件数を追加。取引が無く予定だけある日も返す。

### フロントエンド

明細ブロックの下に予定ブロック。タイトル / 日付 / 時刻（終日切替）/ 詳細メモ / 通知 / 宛先。

- 通知は複数選択（予定の時刻・1時間前・3時間前・前日）
- 宛先は予定ごとに 家族全員 / 自分だけ
- 済・未のトグル
- カレンダーに**青丸**。祝日の赤丸と**縦に並べて併記**する

## 3. 不具合修正

### キーボードで保存ボタンが押せない

キーボードや時刻ピッカーが出ても `vh` は変わらない。見えている領域だけが縮むため、
シート下端の操作ボタンがキーボードの裏へ回り込んでいた。

| 対処 | 効く環境 |
|---|---|
| `visualViewport` の高さを CSS 変数へ入れ、シートの高さに反映 | iOS / Android 両方 |
| viewport meta に `interactive-widget=resizes-content` | Android Chrome |
| 操作ボタンを `position: sticky` | 全環境 |

## 検証

テスト通知を投入して実配信を確認した。

```
通知テスト | status=sent | attempts=1 | last_error=null
send_at 04:00:03Z → sent_at 04:05:01Z
```

1回目の試行で ACS が受理。タイマーが5分周期のため、**予定時刻から最大5分遅れ**で届く。
テスト用の予定は削除済み。

## デプロイ結果

| 対象 | 結果 |
|---|---|
| マイグレーション 009 / 010 | 適用済み |
| Function App | 成功。`reminderSweep` がタイマートリガとして登録された |
| SWA | `4087a91` → `8858123` を push、配信確認済み |

## 残課題

| 項目 | 状態 |
|---|---|
| メールの受信確認 | **利用者の確認待ち**。初回は迷惑メールに入る可能性がある |
| Google Places | 将来の選択肢として保留 |
| 分析ダッシュボード / 定期取引 | 未着手 |
| PC 3ペイン / スマホ下部ナビ | 未着手 |
| L2 ドキュメント | 未着手 |
