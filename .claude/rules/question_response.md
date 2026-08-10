# 質問対応ルール

ユーザーから質問があった場合、下記フローを遵守すること。

## 1. システム全体の把握
`90_DOCUMENT/system_architecture.md` および `system_flow.md` を確認し、全体像を把握する。

## 2. ドキュメント検索
`90_DOCUMENT/` 配下をサブエージェント（Explore エージェント）を並列で走らせて検索する。

**ドキュメント検索スキル**
- `subagent_type: Explore` を使用
- 検索対象: `90_DOCUMENT/**/*.md`
- 目的: 関連する既存ドキュメント・仕様・実装情報の収集

## 3. 外部情報取り込み
対象機能・ライブラリの公式ドキュメントを確認し、1・2 の情報と合わせて回答方針を策定する。
- PostgreSQL 公式: https://www.postgresql.org/docs/
- Azure (Static Web Apps / Functions): https://learn.microsoft.com/azure/
- Python / psycopg3 / LightGBM 等は各公式ドキュメントを参照

## 4. Q&A
1〜3 の情報を元に質問へ回答する。
回答が複数の選択肢を含む場合はそれぞれのトレードオフを提示し、ユーザーが判断できる形で示すこと。

## 5. 実装判断の誘導
回答の結果としてユーザーが実装・変更を希望する場合、または質問の内容が実装を伴う可能性がある場合は、
**開発手順ルール（`.claude/rules/development_procedure.md`）に従って進めることをユーザーに確認する。**

自己判断で実装に移行しないこと。必ずユーザーの承認を得てから `development_procedure.md` の手順へ誘導する。
