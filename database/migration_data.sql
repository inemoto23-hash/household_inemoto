-- データベースエクスポート SQL

-- expense_categories データ
INSERT INTO expense_categories (id, name, created_at) VALUES (1, '食費', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (2, '生活費', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (3, '養育費', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (4, 'ローン', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (6, '娯楽費', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (7, '車維持費', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (8, '医療費', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (9, '公共料金', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (10, '投資', '2025-08-30 22:55:15');
INSERT INTO expense_categories (id, name, created_at) VALUES (11, 'その他', '2025-08-31 09:15:20');
INSERT INTO expense_categories (id, name, created_at) VALUES (12, 'たけ小遣い', '2025-08-31 13:28:19');
INSERT INTO expense_categories (id, name, created_at) VALUES (13, 'ささ小遣い', '2025-08-31 13:28:19');

-- wallet_categories データ
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (1, '三井住友銀行', 771, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (2, '埼玉りそな銀行', 122844, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (3, '楽天銀行', 548089, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (4, '楽天証券', 415513, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (5, '住信SBI証券', 4855, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (6, '現金たけ', 40470, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (7, '現金ささ', 6607, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (8, 'Suicaたけ', 4476, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (9, 'Suicaささ', 6437, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (10, '楽天Payたけ', 2645, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (11, '楽天Payささ', 7384, '2025-08-30 22:55:15');
INSERT INTO wallet_categories (id, name, balance, created_at) VALUES (12, '家現金', 218700, '2025-08-31 09:11:33');

-- credit_categories データ
INSERT INTO credit_categories (id, name, created_at) VALUES (1, '楽天カード', '2025-08-30 22:55:15');
INSERT INTO credit_categories (id, name, created_at) VALUES (2, 'PayPay', '2025-08-30 22:55:15');

-- monthly_budgets データ
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (44, 2025, 9, 11, 0, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (45, 2025, 9, 4, 66644, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (46, 2025, 9, 9, 45000, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (47, 2025, 9, 8, 10000, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (48, 2025, 9, 6, 20000, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (50, 2025, 9, 10, 0, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (51, 2025, 9, 2, 20000, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (52, 2025, 9, 7, 29000, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (53, 2025, 9, 1, 105400, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (54, 2025, 9, 3, 70000, '2025-08-31 09:34:22');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (55, 2025, 9, 12, 35000, '2025-08-31 13:28:19');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (56, 2025, 9, 13, 35000, '2025-08-31 13:28:19');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (57, 2025, 10, 1, 105400, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (58, 2025, 10, 2, 20000, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (59, 2025, 10, 3, 70000, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (60, 2025, 10, 4, 66644, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (61, 2025, 10, 6, 20000, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (62, 2025, 10, 7, 29000, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (63, 2025, 10, 8, 10000, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (64, 2025, 10, 9, 45000, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (65, 2025, 10, 10, 0, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (66, 2025, 10, 11, 0, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (67, 2025, 10, 12, 35000, '2025-09-01 14:01:30');
INSERT INTO monthly_budgets (id, year, month, expense_category_id, budget_amount, created_at) VALUES (68, 2025, 10, 13, 35000, '2025-09-01 14:01:30');

-- transactions データ
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (8, '2025-09-01', 66644, 'expense', NULL, 3, NULL, '振替出金: 住宅ローン振込', '', '2025-08-31 11:28:48', '2025-08-31 11:28:48', '', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (9, '2025-09-01', 66644, 'income', NULL, 5, NULL, '振替入金: 住宅ローン振込', '', '2025-08-31 11:28:48', '2025-08-31 11:28:48', '', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (11, '2025-09-01', 66644, 'expense', 4, 5, NULL, '住宅ローン支払い', '', '2025-08-31 11:31:24', '2025-08-31 11:31:24', '', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (18, '2025-09-01', 35000, 'expense', 12, NULL, NULL, '予算残高手動調整 (2025年9月)', 'システムによる予算残高調整', '2025-08-31 13:35:10', '2025-08-31 13:35:10', '予算調整', '手動調整: ¥-35,000');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (19, '2025-09-01', 20000, 'expense', 12, NULL, NULL, '予算残高手動調整 (2025年9月)', 'システムによる予算残高調整', '2025-08-31 13:35:31', '2025-08-31 13:35:31', '予算調整', '手動調整: ¥-20,000');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (21, '2025-09-01', 45000, 'expense', 13, NULL, NULL, '予算残高手動調整 (2025年9月)', 'システムによる予算残高調整', '2025-09-01 13:49:25', '2025-09-01 13:49:25', '予算調整', '手動調整: ¥-45,000');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (22, '2025-09-01', 368, 'expense', 1, 10, NULL, '昼ごはん', '', '2025-09-01 13:50:34', '2025-09-01 13:50:34', 'ファミマ', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (23, '2025-09-01', 750, 'expense', 1, NULL, 2, '夕飯', '', '2025-09-01 13:51:16', '2025-09-01 13:51:16', '日高屋', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (24, '2025-09-01', 484, 'expense', 2, 9, NULL, '交通費', '', '2025-09-01 13:54:14', '2025-09-01 13:54:14', '駅', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (25, '2025-09-01', 100, 'expense', 2, 9, NULL, '自転車', '', '2025-09-01 13:54:53', '2025-09-01 14:04:00', '駐輪場', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (26, '2025-09-01', 92, 'expense', 1, 11, NULL, 'ドレッシングとおやつ', '', '2025-09-01 13:56:02', '2025-09-01 13:56:02', 'セブンイレブン', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (27, '2025-09-01', 220, 'expense', 3, 11, NULL, 'お食事エプロン', '', '2025-09-01 13:56:59', '2025-09-01 13:56:59', 'ダイソー', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (28, '2025-09-01', 445, 'expense', 3, 11, NULL, 'ゆき帽子', '', '2025-09-01 13:57:51', '2025-09-01 13:57:51', '西松屋', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (29, '2025-09-01', 386, 'expense', 1, 11, NULL, '食パンとゆきパン', '', '2025-09-01 13:59:00', '2025-09-01 13:59:00', 'セキ薬品', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (30, '2025-09-01', 2500, 'expense', 3, 12, NULL, '保育園', '', '2025-09-01 13:59:29', '2025-09-01 13:59:29', 'まむろ', '');
INSERT INTO transactions (id, date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, created_at, updated_at, payment_location, notes) VALUES (31, '2025-09-01', 5250, 'expense', 12, NULL, 1, 'グラブル', '', '2025-09-01 14:00:35', '2025-09-01 14:00:35', '', '');

-- monthly_credit_summary データ
INSERT INTO monthly_credit_summary (id, year, month, credit_category_id, total_amount, created_at, updated_at) VALUES (1, 2025, 8, 1, 0, '2025-08-31 06:17:24', '2025-08-31 06:17:24');
INSERT INTO monthly_credit_summary (id, year, month, credit_category_id, total_amount, created_at, updated_at) VALUES (2, 2025, 9, 2, 750, '2025-09-01 13:51:16', '2025-09-01 13:51:16');
INSERT INTO monthly_credit_summary (id, year, month, credit_category_id, total_amount, created_at, updated_at) VALUES (3, 2025, 9, 1, 5250, '2025-09-01 14:00:35', '2025-09-01 14:00:35');

