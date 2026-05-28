@echo off
setlocal
cd /d "%~dp0admin"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm not found. Install with: npm install -g pnpm
  pause
  exit /b 1
)

if not exist node_modules (
  echo First-time install...
  call pnpm install
  if errorlevel 1 (
    echo Install failed.
    pause
    exit /b 1
  )
)

if not exist .env.local (
  echo Copying .env.example to .env.local — set your TMDB_API_KEY then re-run.
  copy .env.example .env.local >nul
  notepad .env.local
)

call pnpm dev
