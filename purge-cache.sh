#!/bin/bash
# purge-cache.sh — blow away all opencode-acm cache copies
# Run this before restarting OpenCode to force a fresh plugin load.

rm -rf ~/.bun/install/cache/opencode-acm* && echo "bun cache: cleared"
rm -rf ~/.cache/opencode/node_modules/opencode-acm && echo "opencode node_modules cache: cleared"
rm -rf ~/.cache/opencode/packages/opencode-acm@latest && echo "opencode packages cache: cleared"

echo "All done. Restart OpenCode."
