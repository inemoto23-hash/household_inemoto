// あいまい登録機能

let fuzzyExpenseCategories = [];
let fuzzyWalletCategories = [];
let fuzzyCreditCategories = [];

// あいまい登録タブ初期化
function initFuzzyRegister() {
    const fuzzyTab = document.getElementById('fuzzy-tab');
    const parseFuzzyBtn = document.getElementById('parse-fuzzy');
    const registerFuzzyBtn = document.getElementById('register-fuzzy');
    const fuzzyPaymentMethod = document.querySelectorAll('input[name="fuzzy-payment-method"]');

    if (!fuzzyTab) return;

    // カテゴリを読み込み
    loadFuzzyCategories();

    // タブクリック
    fuzzyTab.addEventListener('click', () => {
        switchView('fuzzy-view');
        // 日本時間で今日の日付を設定
        const now = new Date();
        const jstOffset = 9 * 60; // JST is UTC+9
        const jstDate = new Date(now.getTime() + jstOffset * 60 * 1000);
        const year = jstDate.getUTCFullYear();
        const month = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(jstDate.getUTCDate()).padStart(2, '0');
        document.getElementById('fuzzy-date').value = `${year}-${month}-${day}`;
    });

    // 解析ボタン
    if (parseFuzzyBtn) {
        parseFuzzyBtn.addEventListener('click', parseFuzzyInput);
    }

    // 登録ボタン
    if (registerFuzzyBtn) {
        registerFuzzyBtn.addEventListener('click', registerFuzzyTransaction);
    }

    // 支払い方法切り替え
    fuzzyPaymentMethod.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const isWallet = e.target.value === 'wallet';
            document.getElementById('fuzzy-wallet-group').classList.toggle('hidden', !isWallet);
            document.getElementById('fuzzy-credit-group').classList.toggle('hidden', isWallet);
        });
    });
}

// カテゴリを読み込み
async function loadFuzzyCategories() {
    try {
        const [expenses, wallets, credits, locations] = await Promise.all([
            fetch('/api/expense-categories').then(r => r.json()),
            fetch('/api/wallet-categories').then(r => r.json()),
            fetch('/api/credit-categories').then(r => r.json()),
            fetch('/api/payment-locations').then(r => r.json())
        ]);

        fuzzyExpenseCategories = expenses;
        fuzzyWalletCategories = wallets;
        fuzzyCreditCategories = credits;

        // セレクトボックスに追加
        const expenseSelect = document.getElementById('fuzzy-expense-category');
        const walletSelect = document.getElementById('fuzzy-wallet-category');
        const creditSelect = document.getElementById('fuzzy-credit-category');
        const locationDatalist = document.getElementById('fuzzy-payment-locations');

        if (expenseSelect) {
            expenseSelect.innerHTML = '<option value="">選択してください</option>';
            expenses.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.id;
                option.textContent = cat.name;
                expenseSelect.appendChild(option);
            });
        }

        if (walletSelect) {
            walletSelect.innerHTML = '<option value="">選択してください</option>';
            wallets.forEach(wallet => {
                const option = document.createElement('option');
                option.value = wallet.id;
                option.textContent = wallet.name;
                walletSelect.appendChild(option);
            });
        }

        if (creditSelect) {
            creditSelect.innerHTML = '<option value="">選択してください</option>';
            credits.forEach(credit => {
                const option = document.createElement('option');
                option.value = credit.id;
                option.textContent = credit.name;
                creditSelect.appendChild(option);
            });
        }

        if (locationDatalist) {
            locationDatalist.innerHTML = '';
            locations.forEach(loc => {
                const option = document.createElement('option');
                option.value = loc.name;
                locationDatalist.appendChild(option);
            });
        }

    } catch (error) {
        console.error('カテゴリ読み込みエラー:', error);
    }
}

// あいまい入力を解析
async function parseFuzzyInput() {
    const input = document.getElementById('fuzzy-input').value.trim();

    if (!input) {
        alert('取引内容を入力してください');
        return;
    }

    const parseBtn = document.getElementById('parse-fuzzy');
    parseBtn.disabled = true;
    parseBtn.textContent = '解析中...';

    try {
        const response = await fetch('/api/parse-fuzzy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: input })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || '解析に失敗しました');
        }

        // 解析結果をフォームに反映
        populateFuzzyForm(result);

        // 結果エリアを表示
        document.getElementById('fuzzy-result').classList.remove('hidden');

        // 不足項目をチェック
        checkMissingFields(result);

    } catch (error) {
        console.error('解析エラー:', error);
        alert('解析エラー: ' + error.message);
    } finally {
        parseBtn.disabled = false;
        parseBtn.textContent = '解析';
    }
}

// 解析結果をフォームに反映
function populateFuzzyForm(result) {
    // 日付（APIから返された日付、なければ今日の日付）
    const dateInput = document.getElementById('fuzzy-date');
    if (result.date) {
        dateInput.value = result.date;
    } else {
        // 日本時間で今日の日付を設定
        const now = new Date();
        const jstOffset = 9 * 60; // JST is UTC+9
        const jstDate = new Date(now.getTime() + jstOffset * 60 * 1000);
        const year = jstDate.getUTCFullYear();
        const month = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(jstDate.getUTCDate()).padStart(2, '0');
        dateInput.value = `${year}-${month}-${day}`;
    }

    // 種別
    if (result.type) {
        document.getElementById('fuzzy-type').value = result.type;
    }

    // 金額
    if (result.amount) {
        document.getElementById('fuzzy-amount').value = result.amount;
    }

    // 出費カテゴリ
    if (result.expense_category_id) {
        document.getElementById('fuzzy-expense-category').value = result.expense_category_id;
    }

    // 支払い方法
    const isWallet = result.wallet_category_id != null;
    const paymentMethod = isWallet ? 'wallet' : 'credit';
    document.querySelector(`input[name="fuzzy-payment-method"][value="${paymentMethod}"]`).checked = true;

    // 財布またはクレジット
    if (isWallet) {
        document.getElementById('fuzzy-wallet-category').value = result.wallet_category_id || '';
        document.getElementById('fuzzy-wallet-group').classList.remove('hidden');
        document.getElementById('fuzzy-credit-group').classList.add('hidden');
    } else {
        document.getElementById('fuzzy-credit-category').value = result.credit_category_id || '';
        document.getElementById('fuzzy-wallet-group').classList.add('hidden');
        document.getElementById('fuzzy-credit-group').classList.remove('hidden');
    }

    // 説明
    if (result.description) {
        document.getElementById('fuzzy-description').value = result.description;
    }

    // 決済場所
    if (result.payment_location) {
        document.getElementById('fuzzy-payment-location').value = result.payment_location;
    }

    // メモ
    if (result.memo) {
        document.getElementById('fuzzy-memo').value = result.memo;
    }
}

// 必須項目をチェック
function checkMissingFields(result) {
    const missingInfo = document.getElementById('fuzzy-missing-info');
    const missingList = document.getElementById('fuzzy-missing-list');
    const missing = [];

    if (!result.type || result.type === '') missing.push('種別');
    if (!result.amount || result.amount === 0) missing.push('金額');
    if (!result.expense_category_id) missing.push('出費カテゴリ');
    if (!result.wallet_category_id && !result.credit_category_id) missing.push('財布カテゴリまたはクレジットカード');
    if (!result.description || result.description === '') missing.push('説明');

    if (missing.length > 0) {
        missingList.innerHTML = missing.map(field => `<li>${field}</li>`).join('');
        missingInfo.style.display = 'block';
    } else {
        missingInfo.style.display = 'none';
    }
}

// あいまい登録を実行
async function registerFuzzyTransaction() {
    // バリデーション
    const type = document.getElementById('fuzzy-type').value;
    const amount = parseFloat(document.getElementById('fuzzy-amount').value);
    const expenseCategoryId = document.getElementById('fuzzy-expense-category').value;
    const description = document.getElementById('fuzzy-description').value.trim();
    const paymentMethod = document.querySelector('input[name="fuzzy-payment-method"]:checked').value;

    const missing = [];
    if (!type) missing.push('種別');
    if (!amount || amount <= 0) missing.push('金額');
    if (!expenseCategoryId) missing.push('出費カテゴリ');
    if (!description) missing.push('説明');

    if (paymentMethod === 'wallet') {
        const walletCategoryId = document.getElementById('fuzzy-wallet-category').value;
        if (!walletCategoryId) missing.push('財布カテゴリ');
    } else {
        const creditCategoryId = document.getElementById('fuzzy-credit-category').value;
        if (!creditCategoryId) missing.push('クレジットカード');
    }

    if (missing.length > 0) {
        const missingInfo = document.getElementById('fuzzy-missing-info');
        const missingList = document.getElementById('fuzzy-missing-list');
        missingList.innerHTML = missing.map(field => `<li>${field}</li>`).join('');
        missingInfo.style.display = 'block';
        alert('必須項目を入力してください');
        return;
    }

    // 取引データを作成
    const data = {
        date: document.getElementById('fuzzy-date').value,
        type,
        amount,
        expense_category_id: parseInt(expenseCategoryId),
        description,
        payment_location: document.getElementById('fuzzy-payment-location').value.trim(),
        memo: document.getElementById('fuzzy-memo').value.trim()
    };

    if (paymentMethod === 'wallet') {
        data.wallet_category_id = parseInt(document.getElementById('fuzzy-wallet-category').value);
    } else {
        data.credit_category_id = parseInt(document.getElementById('fuzzy-credit-category').value);
    }

    // 登録
    try {
        const response = await fetch('/api/transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || '登録に失敗しました');
        }

        alert('取引を登録しました！');

        // フォームをクリア
        document.getElementById('fuzzy-input').value = '';
        document.getElementById('fuzzy-result').classList.add('hidden');
        document.getElementById('fuzzy-type').value = '';
        document.getElementById('fuzzy-amount').value = '';
        document.getElementById('fuzzy-expense-category').value = '';
        document.getElementById('fuzzy-description').value = '';
        document.getElementById('fuzzy-payment-location').value = '';
        document.getElementById('fuzzy-memo').value = '';
        document.getElementById('fuzzy-missing-info').style.display = 'none';

        // カレンダーを更新（既存の関数を呼び出し）
        if (typeof loadCalendar === 'function') {
            loadCalendar(currentYear, currentMonth);
        }

    } catch (error) {
        console.error('登録エラー:', error);
        alert('登録エラー: ' + error.message);
    }
}

// 初期化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFuzzyRegister);
} else {
    initFuzzyRegister();
}
