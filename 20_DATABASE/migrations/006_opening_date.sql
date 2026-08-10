-- ===============================================================
-- 006: 口座残高ビューが期首日を尊重するようにする
--
-- opening_balance は「opening_date 時点の残高」を表す。
-- ところがビューは全期間の取引を合算していたため、
-- 期首日より前の取引があると期首残高と二重に効いてしまう。
--
-- 期首残高を画面から設定できるようにするにあたり、意味を正す。
-- ===============================================================

ALTER VIEW dbo.vw_account_balances
AS
SELECT
    a.id            AS account_id,
    a.household_id,
    a.name,
    a.kind,
    a.opening_balance
      + ISNULL(mv.delta, 0) AS balance
FROM dbo.accounts a
OUTER APPLY (
    SELECT SUM(x.delta) AS delta
    FROM (
        SELECT CASE e.kind
                    WHEN N'income'   THEN  e.amount
                    WHEN N'refund'   THEN  e.amount
                    WHEN N'expense'  THEN -e.amount
                    WHEN N'transfer' THEN -e.amount
               END AS delta
        FROM dbo.entries e
        WHERE e.account_id = a.id
          AND e.is_deleted = 0
          AND e.entry_date >= a.opening_date
        UNION ALL
        SELECT e.amount AS delta
        FROM dbo.entries e
        WHERE e.counter_account_id = a.id
          AND e.kind = N'transfer'
          AND e.is_deleted = 0
          AND e.entry_date >= a.opening_date
    ) x
) mv
GO
