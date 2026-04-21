#!/bin/bash
# publish.sh — build, publish, and purge all opencode-acm caches
set -e

echo "Building and publishing opencode-acm..."
npm publish

echo "Purging bun cache..."
rm -rf ~/.bun/install/cache/opencode-acm* 2>/dev/null || true

echo "Purging opencode cache..."
rm -rf ~/.cache/opencode/node_modules/opencode-acm 2>/dev/null || true
rm -rf ~/.cache/opencode/packages/opencode-acm@latest 2>/dev/null || true

echo "Done. Restart OpenCode to load the new version."
