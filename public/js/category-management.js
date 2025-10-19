// ====================================
// カテゴリ管理機能
// ====================================

// カテゴリ管理画面を読み込み
async function loadCategoryManagement() {
    await loadCategories();
    displayCategoryLists();
    setupCategoryEventListeners();
}

// カテゴリ一覧を表示
function displayCategoryLists() {
    // 出費カテゴリ一覧
    const expenseList = document.getElementById('expense-category-list');
    expenseList.innerHTML = '';
    expenseCategories.forEach(category => {
        const item = document.createElement('div');
        item.className = 'category-item';
        item.innerHTML = `<span class="category-item-name">${category.name}</span>`;
        expenseList.appendChild(item);
    });

    // 財布カテゴリ一覧
    const walletList = document.getElementById('wallet-category-list');
    walletList.innerHTML = '';
    walletCategories.forEach(category => {
        const item = document.createElement('div');
        item.className = 'category-item';
        item.innerHTML = `
            <span class="category-item-name">${category.name}</span>
            <span class="category-item-balance">¥${parseFloat(category.balance || 0).toLocaleString()}</span>
        `;
        walletList.appendChild(item);
    });

    // クレジットカードカテゴリ一覧
    const creditList = document.getElementById('credit-category-list');
    creditList.innerHTML = '';
    creditCategories.forEach(category => {
        const item = document.createElement('div');
        item.className = 'category-item';
        item.innerHTML = `<span class="category-item-name">${category.name}</span>`;
        creditList.appendChild(item);
    });
}

// カテゴリ管理画面のイベントリスナー設定
function setupCategoryEventListeners() {
    // 出費カテゴリ追加
    const addExpenseBtn = document.getElementById('add-expense-category');
    const newExpenseInput = document.getElementById('new-expense-category');

    addExpenseBtn.onclick = async () => {
        const name = newExpenseInput.value.trim();
        if (!name) {
            alert('カテゴリ名を入力してください');
            return;
        }

        try {
            const response = await fetch('/api/expense-categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });

            const result = await response.json();

            if (!response.ok) {
                alert(result.error || 'カテゴリの追加に失敗しました');
                return;
            }

            alert(result.message);
            newExpenseInput.value = '';
            await loadCategoryManagement();
            await populateSelects();
        } catch (error) {
            console.error('出費カテゴリ追加エラー:', error);
            alert('カテゴリの追加に失敗しました');
        }
    };

    // 財布カテゴリ追加
    const addWalletBtn = document.getElementById('add-wallet-category');
    const newWalletInput = document.getElementById('new-wallet-category');
    const newWalletBalanceInput = document.getElementById('new-wallet-balance');

    addWalletBtn.onclick = async () => {
        const name = newWalletInput.value.trim();
        const balance = parseFloat(newWalletBalanceInput.value) || 0;

        if (!name) {
            alert('カテゴリ名を入力してください');
            return;
        }

        try {
            const response = await fetch('/api/wallet-categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, balance })
            });

            const result = await response.json();

            if (!response.ok) {
                alert(result.error || 'カテゴリの追加に失敗しました');
                return;
            }

            alert(result.message);
            newWalletInput.value = '';
            newWalletBalanceInput.value = '0';
            await loadCategoryManagement();
            await populateSelects();
        } catch (error) {
            console.error('財布カテゴリ追加エラー:', error);
            alert('カテゴリの追加に失敗しました');
        }
    };

    // クレジットカードカテゴリ追加
    const addCreditBtn = document.getElementById('add-credit-category');
    const newCreditInput = document.getElementById('new-credit-category');

    addCreditBtn.onclick = async () => {
        const name = newCreditInput.value.trim();
        if (!name) {
            alert('カテゴリ名を入力してください');
            return;
        }

        try {
            const response = await fetch('/api/credit-categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });

            const result = await response.json();

            if (!response.ok) {
                alert(result.error || 'カテゴリの追加に失敗しました');
                return;
            }

            alert(result.message);
            newCreditInput.value = '';
            await loadCategoryManagement();
            await populateSelects();
        } catch (error) {
            console.error('クレジットカードカテゴリ追加エラー:', error);
            alert('カテゴリの追加に失敗しました');
        }
    };
}
