// あいまい登録機能

let fuzzyExpenseCategories = [];
let fuzzyWalletCategories = [];
let fuzzyCreditCategories = [];
let recognition = null; // 音声認識オブジェクト

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

    // 音声入力ボタン
    const voiceInputBtn = document.getElementById('voice-input-btn');
    if (voiceInputBtn) {
        voiceInputBtn.addEventListener('click', startVoiceInput);
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

    // 音声認識の初期化
    initVoiceRecognition();
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

        // 解析結果を収支登録フォームに反映して入力タブに移動
        populateMainForm(result);

        // 入力タブに切り替え
        showView('input');

        // 入力テキストをクリア
        document.getElementById('fuzzy-input').value = '';

    } catch (error) {
        console.error('解析エラー:', error);
        alert('解析エラー: ' + error.message);
    } finally {
        parseBtn.disabled = false;
        parseBtn.textContent = '解析';
    }
}

// 解析結果を収支登録フォーム（メインフォーム）に反映
function populateMainForm(result) {
    console.log('=== 解析結果（生データ） ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('========================');

    // 種別（最初に設定してDOMを構築）
    if (result.type) {
        document.getElementById('transaction-type').value = result.type;
        console.log('種別を設定:', result.type);
        // 種別変更イベントを発火して表示を切り替え
        toggleExpenseCategory();
    }

    // toggleExpenseCategory()でDOMが更新されるのを待ってから値を設定
    setTimeout(() => {
        // 日付（必ず設定）
        const dateInput = document.getElementById('transaction-date');
        console.log('result.dateの値:', result.date, 'typeof:', typeof result.date);

        if (result.date) {
            // ISO形式の場合はYYYY-MM-DDに変換
            const dateStr = result.date.split('T')[0];
            dateInput.value = dateStr;
            console.log('日付を設定（API）:', dateStr);
        } else {
            // 日付がない場合は今日の日付を設定
            const now = new Date();
            const jstOffset = 9 * 60 * 60 * 1000;
            const jstDate = new Date(now.getTime() + jstOffset);
            const todayStr = jstDate.toISOString().split('T')[0];
            dateInput.value = todayStr;
            console.log('日付を設定（今日）:', todayStr);
        }
        console.log('最終的な日付の値:', dateInput.value);

        // 金額（必ず設定）
        if (result.amount) {
            document.getElementById('transaction-amount').value = result.amount;
            console.log('金額を設定:', result.amount);
        }

        // 説明（必ず設定）
        if (result.description) {
            document.getElementById('transaction-description').value = result.description;
            console.log('説明を設定:', result.description);
        }

        // メモ（任意）
        if (result.memo) {
            document.getElementById('transaction-memo').value = result.memo;
            console.log('メモを設定:', result.memo);
        }

        // 決済場所（任意）
        if (result.payment_location) {
            document.getElementById('payment-location').value = result.payment_location;
            console.log('決済場所を設定:', result.payment_location);
        }

        // 種別に応じた設定
        if (result.type === 'expense' || result.type === 'income') {
            // 出費カテゴリ（支出の場合のみ）
            if (result.type === 'expense' && result.expense_category_id) {
                document.getElementById('expense-category').value = result.expense_category_id;
                console.log('出費カテゴリを設定:', result.expense_category_id);
            }

            // 支払い方法
            if (result.wallet_category_id) {
                document.querySelector('input[name="payment-method"][value="wallet"]').checked = true;
                togglePaymentMethod();
                // 収支登録の財布セレクトはIDのみ（wallet_X形式ではない）
                document.getElementById('wallet-category').value = result.wallet_category_id;
                console.log('財布を設定:', result.wallet_category_id);
            } else if (result.credit_category_id) {
                document.querySelector('input[name="payment-method"][value="credit"]').checked = true;
                togglePaymentMethod();
                // 収支登録のクレジットセレクトはIDのみ（credit_X形式ではない）
                document.getElementById('credit-category').value = result.credit_category_id;
                console.log('クレジットカードを設定:', result.credit_category_id);
            }
        } else if (result.type === 'transfer') {
            // 振替（数値IDをそのまま使用）
            if (result.transfer_from_wallet_id) {
                document.getElementById('transfer-from').value = result.transfer_from_wallet_id;
                console.log('振替元を設定:', result.transfer_from_wallet_id);
            }
            if (result.transfer_to_wallet_id) {
                document.getElementById('transfer-to').value = result.transfer_to_wallet_id;
                console.log('振替先を設定:', result.transfer_to_wallet_id);
            }
        } else if (result.type === 'charge') {
            console.log('=== チャージの設定開始 ===');
            console.log('charge_to_wallet:', result.charge_to_wallet);
            console.log('charge_to_wallet_id:', result.charge_to_wallet_id);
            console.log('charge_from_credit:', result.charge_from_credit);
            console.log('charge_from_credit_id:', result.charge_from_credit_id);

            // チャージ先（数値IDをそのまま使用）
            const chargeToSelect = document.getElementById('charge-to-wallet');
            if (result.charge_to_wallet_id) {
                chargeToSelect.value = result.charge_to_wallet_id;
                console.log('✅ チャージ先を設定:', result.charge_to_wallet_id);
            } else {
                console.log('⚠️ charge_to_wallet_idが存在しません');
            }
            console.log('チャージ先の最終値:', chargeToSelect.value);

            // チャージ元（楽天カードを自動選択）
            const chargeFromSelect = document.getElementById('charge-from-source');
            console.log('chargeFromSelectの存在:', !!chargeFromSelect);
            console.log('chargeFromSelectのオプション数:', chargeFromSelect?.options.length);

            if (chargeFromSelect) {
                // 全オプションを表示
                console.log('=== 全オプション ===');
                for (let i = 0; i < chargeFromSelect.options.length; i++) {
                    const opt = chargeFromSelect.options[i];
                    console.log(`オプション[${i}]: value="${opt.value}" text="${opt.text}"`);
                }
                console.log('==================');

                if (result.charge_from_credit_id) {
                    // IDをcredit_X形式に変換
                    const creditValue = `credit_${result.charge_from_credit_id}`;
                    console.log(`設定しようとしているID: ${result.charge_from_credit_id} → ${creditValue}`);
                    chargeFromSelect.value = creditValue;
                    console.log('✅ チャージ元を設定（API）:', creditValue);
                    console.log('設定直後の値:', chargeFromSelect.value);

                    // 値が設定されているか確認
                    if (!chargeFromSelect.value) {
                        console.log('❌ 値が設定されませんでした。楽天カードを探します...');
                        // 楽天カードを探して設定
                        for (let option of chargeFromSelect.options) {
                            if (option.text.includes('楽天カード')) {
                                chargeFromSelect.value = option.value;
                                console.log('✅ チャージ元に楽天カードを自動設定:', option.value);
                                break;
                            }
                        }
                    }
                } else {
                    console.log('⚠️ charge_from_credit_idが存在しない。楽天カードを探します...');
                    // 楽天カードを探して設定
                    let found = false;
                    for (let option of chargeFromSelect.options) {
                        if (option.text.includes('楽天カード')) {
                            chargeFromSelect.value = option.value;
                            console.log('✅ チャージ元に楽天カードを自動設定:', option.value);
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        console.log('❌ 楽天カードが見つかりませんでした');
                    }
                }
                console.log('チャージ元の最終値:', chargeFromSelect.value);
            }
            console.log('=== チャージの設定終了 ===');
        }
    }, 200); // DOM更新を確実に待つため200msに延長
}

// 解析結果をあいまい登録フォームに反映（旧関数、使用されない）
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

// 音声認識の初期化
function initVoiceRecognition() {
    // Web Speech APIのサポート確認
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        console.warn('このブラウザは音声認識に対応していません');
        const voiceBtn = document.getElementById('voice-input-btn');
        if (voiceBtn) {
            voiceBtn.style.display = 'none';
        }
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = async (event) => {
        const transcript = event.results[0][0].transcript;
        console.log('音声認識結果:', transcript);

        // テキストエリアに入力
        const fuzzyInput = document.getElementById('fuzzy-input');
        fuzzyInput.value = transcript;

        // 自動で解析を実行
        await parseFuzzyInput();
    };

    recognition.onerror = (event) => {
        console.error('音声認識エラー:', event.error);
        const voiceBtn = document.getElementById('voice-input-btn');
        voiceBtn.classList.remove('listening');
        voiceBtn.textContent = '🎤 音声入力';
        alert('音声認識エラー: ' + event.error);
    };

    recognition.onend = () => {
        const voiceBtn = document.getElementById('voice-input-btn');
        voiceBtn.classList.remove('listening');
        voiceBtn.textContent = '🎤 音声入力';
    };
}

// 音声入力開始
function startVoiceInput() {
    if (!recognition) {
        alert('このブラウザは音声認識に対応していません');
        return;
    }

    const voiceBtn = document.getElementById('voice-input-btn');

    // 既に録音中の場合は停止
    if (voiceBtn.classList.contains('listening')) {
        recognition.stop();
        voiceBtn.classList.remove('listening');
        voiceBtn.textContent = '🎤 音声入力';
        return;
    }

    // 録音開始
    voiceBtn.classList.add('listening');
    voiceBtn.textContent = '🛑 停止';
    recognition.start();
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
