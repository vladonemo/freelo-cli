# Phase 04 — Implement

**Result:** Scaffold in place. Dependencies installed (`pnpm install`, 506 packages, 3m29s). Build produces `dist/freelo.js` (1.91 KB ESM with shebang). Smoke-test: `node dist/freelo.js --version` prints `0.0.0` as expected.

**Artifacts:**
- Manifest: `package.json` + `pnpm-lock.yaml`
- Configs: `tsconfig.json`, `tsup.config.ts`, `eslint.config.js`, `vitest.config.ts`, `commitlint.config.js`, `.prettierrc.json`, `lint-staged.config.js`, `.changeset/config.json`, `.npmrc`, `.gitignore`, `.prettierignore`
- Hooks: `.husky/pre-commit`, `.husky/commit-msg`, `scripts/prepare-husky.mjs`
- Source: `src/bin/freelo.ts`, `src/lib/version.ts`, `src/errors/{base,config-error,index}.ts`
- CI: `.github/workflows/{ci,release}.yml`
- Changeset: `.changeset/initial-scaffold.md` (minor)

**Retries:** 0 (no implementer retries; two minor follow-ups: (a) eslint config-file globs and (b) bare `Error` replaced with `ConfigError`).
