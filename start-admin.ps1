#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "admin")

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "pnpm not found. Install with: npm install -g pnpm"
  exit 1
}

if (-not (Test-Path "node_modules")) {
  Write-Host "First-time install..."
  pnpm install
}

if (-not (Test-Path ".env.local")) {
  Copy-Item ".env.example" ".env.local"
  Write-Host "Created .env.local — set your TMDB_API_KEY then re-run."
  notepad ".env.local"
}

pnpm dev
