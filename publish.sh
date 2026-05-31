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

echo "Removing any pinned opencode-acm from opencode cache manifest..."
node -e "
const fs = require('fs');
const path = process.env.HOME + '/.cache/opencode/package.json';
if (fs.existsSync(path)) {
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (pkg.dependencies && pkg.dependencies['opencode-acm']) {
    delete pkg.dependencies['opencode-acm'];
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2));
    console.log('Removed opencode-acm pin from cache manifest');
  }
}" 2>/dev/null || true

echo "Done. Restart OpenCode to load the new version."
