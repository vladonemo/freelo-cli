# Requirement

GitHub Actions emits a deprecation warning on every workflow run:

> Node.js 20 actions are deprecated. The following actions are running on Node.js 20 and may not work as expected: actions/checkout@v4, actions/setup-node@v4, pnpm/action-setup@v4. Actions will be forced to run with Node.js 24 by default starting June 2nd, 2026. Node.js 20 will be removed from the runner on September 16th, 2026.

Bump the three actions across `.github/workflows/ci.yml` and `.github/workflows/release.yml` to versions whose published changelog explicitly states they target Node.js 24.
