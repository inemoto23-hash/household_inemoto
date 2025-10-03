-- 家計簿システムのデータベーススキーマ

-- 出費カテゴリマスタ
CREATE TABLE expense_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 財布カテゴリマスタ
CREATE TABLE wallet_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    balance DECIMAL(10, 2) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- クレジットカードカテゴリマスタ
CREATE TABLE credit_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 月別予算設定
CREATE TABLE monthly_budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    expense_category_id INTEGER NOT NULL,
    budget_amount DECIMAL(10, 2) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id),
    UNIQUE(year, month, expense_category_id)
);

-- 取引記録
CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('expense', 'income', 'transfer')),
    expense_category_id INTEGER,
    wallet_category_id INTEGER,
    credit_category_id INTEGER,
    description TEXT,
    memo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id),
    FOREIGN KEY (wallet_category_id) REFERENCES wallet_categories(id),
    FOREIGN KEY (credit_category_id) REFERENCES credit_categories(id)
);

-- 月別クレジット使用額サマリー
CREATE TABLE monthly_credit_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    credit_category_id INTEGER NOT NULL,
    total_amount DECIMAL(10, 2) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (credit_category_id) REFERENCES credit_categories(id),
    UNIQUE(year, month, credit_category_id)
);

-- 初期データの投入
INSERT INTO expense_categories (name) VALUES
('食費'),
('生活費'),
('養育費'),
('ローン'),
('小遣い'),
('娯楽費'),
('車維持費'),
('医療費'),
('公共料金'),
('投資');

INSERT INTO wallet_categories (name, balance) VALUES
('三井住友銀行', 0),
('埼玉りそな銀行', 0),
('楽天銀行', 0),
('楽天証券', 0),
('住信SBI証券', 0),
('現金たけ', 0),
('現金ささ', 0),
('Suicaたけ', 0),
('Suicaささ', 0),
('楽天Payたけ', 0),
('楽天Payささ', 0);

INSERT INTO credit_categories (name) VALUES
('楽天カード'),
('PayPay');