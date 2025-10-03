# GitHub Push Script

Write-Host "GitHubリポジトリのURLを入力してください" -ForegroundColor Cyan
Write-Host "例: https://github.com/username/repo.git" -ForegroundColor Gray
$repoUrl = Read-Host "URL"

Set-Location "C:\Users\inemo\Desktop\家計簿アプリ"

Write-Host "`nリモートリポジトリを追加中..." -ForegroundColor Yellow
git remote add origin $repoUrl

Write-Host "ブランチをmainに変更中..." -ForegroundColor Yellow
git branch -M main

Write-Host "GitHubにプッシュ中..." -ForegroundColor Yellow
git push -u origin main

Write-Host "`n完了！次はRailwayでデプロイしてください。" -ForegroundColor Green
Write-Host "DEPLOY.mdファイルを参照してください。" -ForegroundColor Green

Read-Host "`nEnterキーで終了"
