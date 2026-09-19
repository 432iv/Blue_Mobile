#!/usr/bin/env bash
# Blue Mobile v4 — مسح كل بيانات المنظومة (لا يمسح الحساب)
set -euo pipefail
cd "$(dirname "$BASH_SOURCE")/.."
node scripts/wipe.js
