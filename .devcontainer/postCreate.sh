#!/usr/bin/env bash
set -euo pipefail

echo "=== falsestart: post-create setup ==="

# Install dependencies (frozen — reproducible from the committed lockfile)
if [ -f "package.json" ]; then
  echo "Installing pnpm dependencies..."
  pnpm install --frozen-lockfile
fi

# Install git hooks. lefthook is a local devDependency (not global), so invoke it
# through pnpm. `pnpm install` already runs this via the `prepare` script; we
# repeat it explicitly so the step is visible and independent.
if [ -f "lefthook.yml" ]; then
  echo "Installing lefthook git hooks..."
  pnpm exec lefthook install
fi

echo ""
echo "Installed tools:"
echo "   - Node.js:   $(node --version)"
echo "   - pnpm:      $(pnpm --version)"
echo "   - gh:        $(gh --version | head -1)"
echo "   - claude:    $(claude --version 2>/dev/null || echo 'n/a')"
echo "   - gitleaks:  $(gitleaks version 2>/dev/null || echo 'n/a')"
echo "   - hadolint:  $(hadolint --version 2>/dev/null || echo 'n/a')"
echo "   - lefthook:  $(pnpm exec lefthook version 2>/dev/null || echo 'n/a')"
echo ""
echo "Verify everything: pnpm verify"
echo "=== setup complete ==="
