@echo off
chcp 65001 > nul
echo GitHub repository URL (example: https://github.com/username/repo.git)
set /p REPO_URL="URL: "

cd "C:\Users\inemo\Desktop\家計簿アプリ"

echo.
echo Adding remote repository...
git remote add origin %REPO_URL%

echo Renaming branch to main...
git branch -M main

echo Pushing to GitHub...
git push -u origin main

echo.
echo Done! Next, deploy on Railway.
echo See DEPLOY.md for details.
pause
