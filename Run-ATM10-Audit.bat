@echo off
setlocal DisableDelayedExpansion
title ATM10 Runtime Audit
chcp 65001 >nul
pushd "%~dp0" >nul 2>&1
if errorlevel 1 goto folder_error

where node.exe >nul 2>&1
if errorlevel 1 goto node_error
node.exe -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22 || v[0]===22 && v[1]>=14 ? 0 : 1)"
if errorlevel 1 goto node_error
if not exist "%~dp0scripts\windows-audit.mjs" goto extract_error

node.exe "%~dp0scripts\windows-audit.mjs" %*
set "ATM10_AUDIT_EXIT=%errorlevel%"
goto finish

:node_error
echo.
echo Node.js 22.14 or newer is required, including npm.
echo Install Node.js from https://nodejs.org/ and then reopen this file.
set "ATM10_AUDIT_EXIT=1"
goto finish

:extract_error
echo.
echo Please extract the complete repository ZIP first.
echo Keep this BAT file alongside package.json and the scripts folder.
set "ATM10_AUDIT_EXIT=1"
goto finish

:folder_error
echo Could not open the folder containing this launcher.
if not defined ATM10_AUDIT_NO_PAUSE pause
exit /b 1

:finish
echo.
if not defined ATM10_AUDIT_NO_PAUSE pause
popd
exit /b %ATM10_AUDIT_EXIT%
