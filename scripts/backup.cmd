@echo off
chcp 65001 >nul
rem 双击我就能备份整个项目。需要电脑上有 Node（没有也没关系，见下面的提示）。
cd /d "%~dp0.."
where node >/dev/null 2>nul
if errorlevel 1 (
  echo.
  echo 这台电脑没装 Node，脚本跑不了。
  echo 最简单的替代办法：把整个项目文件夹复制一份，文件夹名后面加上今天的日期。
  echo 一样能起到备份作用。
  echo.
  pause
  exit /b 1
)
node scripts\backup.js
echo.
pause
