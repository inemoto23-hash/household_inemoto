// デフォルト設定を適用する関数
function applyDefaultSettings() {
    // 並び順設定のデフォルト値
    const defaultSettings = {
        // 出費カテゴリの並び順（たけ・ささ小遣い分離済み）
        expenseCategoryOrder: [
            '食費', '生活費', '養育費', 'ローン', '娯楽費', 
            '車維持費', '医療費', '公共料金', '投資', 'その他',
            'たけ小遣い', 'ささ小遣い'
        ],
        
        // 財布の並び順
        walletOrder: [
            '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'
        ],
        
        // クレジットカードの並び順
        creditSummaryOrder: [
            '楽天カード', 'Amazon Mastercard'
        ]
    };
    
    // LocalStorageに設定がない場合のみデフォルト値を設定
    Object.keys(defaultSettings).forEach(key => {
        if (!localStorage.getItem(key)) {
            localStorage.setItem(key, JSON.stringify(defaultSettings[key]));
            console.log(`デフォルト設定を適用: ${key}`);
        }
    });
}

// ページ読み込み時にデフォルト設定を適用
if (typeof window !== 'undefined') {
    applyDefaultSettings();
}