# AGENTS.md

Guidance for AI coding agents and contributors. `CLAUDE.md` imports this file, and `.github/copilot-instructions.md` adds the review checklist.

## Language

- All deliverables are written in **English**: commit messages, PR/Issue titles and bodies, review comments, code comments and docstrings, and documentation (`README.md`, `AGENTS.md`, etc.).
- Exceptions (keep as is): Japanese feed titles, descriptions and page content that the services output or match against (for example the `メンテナンス中` check in the FF14 services), test fixtures, quotations, technical identifiers, generated files, and external source text.
- Runtime messages (logs, errors) are English.
- Do not rewrite Git history to change the language of past commits.

## Overview

A personal RSS collector and deliverer. `src/main.ts` runs every service in `src/services/`, writes one RSS 2.0 file per service plus `index.html` and the deleted-articles history to `output/`, and the `Update RSS` workflow publishes `output/` to GitHub Pages (`https://book000.github.io/rss-deliver/`) hourly. See `README.md` for the list of feeds and the output layout.

The published site is also an input: the previous feed (`<ServiceClassName>.xml`) and `deleted-articles-history.json` are fetched from GitHub Pages to inherit `pubDate`, detect deleted articles and carry over items.

## Commands

```bash
pnpm install        # install dependencies (other package managers are rejected by preinstall)
pnpm start          # run src/main.ts once with tsx (real requests; writes ./output)
pnpm dev            # same with tsx watch
pnpm lint           # run-z: prettier --check src, eslint, tsc
pnpm fix            # run-z: prettier --write src, eslint --fix
pnpm exec tsx src/verify/disney-parks-new-shows.ts   # offline verification of DisneyParksNewShows (fixtures only)
```

There is no build step and no test framework; `tsx` runs the TypeScript directly. Run `pnpm lint` before committing, and the verify script when you touch `src/utils/show-classifier.ts` or `src/services/disney-parks-new-shows.ts`. Node.js is pinned in `.node-version` and pnpm in `package.json`.

CI (`.github/workflows/nodejs-ci-pnpm.yml`) calls the reusable pnpm workflow from `book000/templates`. `.depcheckrc.json` ignores the ESLint plugins that are only referenced from the config. `canvas` needs the apt packages in `.github/apt-packages.txt` to build, and the platforms of the native binaries of `canvas` and `sharp` are limited by `pnpm.supportedArchitectures` in `package.json`. CI must pass before merging.

## Structure

- `src/main.ts`: entry point. Runs the services (registered in the `services` array), writes the feeds, detects deleted articles and generates `index.html` from `template.html`.
- `src/base-service.ts`: abstract `BaseService` (`information()`, `collect()`, and `processPubDates()` which `main.ts` calls).
- `src/services/`: one class per feed. The class name is the feed file name.
- `src/types.d.ts`: ambient type declarations.
- `src/model/`: `collect-result.ts` (`Item`, `CollectResult`), `service-information.ts` (channel fields), `deleted-article.ts`.
- `src/utils/`: `previous-feed.ts` (loads the published feed, `inheritPubDate`), `deleted-articles-tracker.ts` (detects deleted articles and writes `output/deleted-articles-history.json`, on every run), `article-fetcher.ts` (`fetchArticleWithCache`, cache in `.article-cache/<kebab-case class name>`), `show-classifier.ts` (rule-based classifier for `DisneyParksNewShows`).
- `src/verify/`: offline verification script and fixtures.
- `.github/workflows/update-rss.yml`: hourly collection and GitHub Pages deployment on a self-hosted runner.

### Adding a service

1. Create a class in `src/services/` that extends `BaseService` and implements `information()` and `collect()`.
2. Register it in the `services` array in `src/main.ts`.
3. Use the built-in `fetch` (there is no HTTP client dependency), `cheerio` for HTML, `fast-xml-parser` for XML, and `fetchArticleWithCache` for article pages.
4. Log with `Logger.configure(...)` from `@book000/node-utils`.
5. Do not implement `pubDate` fallback or deleted-article tracking in a service; `main.ts` and `BaseService` handle them.

When a source is unavailable, return `{ status: false, items: [] }` (a service that throws is also caught per service in `main.ts`), so one failing source does not stop the run. No feed file is written for that service in that run.

## Conventions

- TypeScript (ESM) with `strict`. Declare types explicitly, avoid `any`, and do not enable `skipLibCheck`.
- ESLint (`@book000/eslint-config`) and Prettier; `pnpm lint` enforces them.
- Naming: classes `PascalCase`, functions and variables `camelCase`, constants `UPPER_SNAKE_CASE`.
- Write JSDoc for functions and interfaces; keep `@param`/`@returns`/`@throws` in sync with the code.
- Inside `src/services` and `src/utils`, prefer the `@/*` alias (`src/*`, set in `tsconfig.json`); `src/main.ts`, `src/base-service.ts` and one import in `src/utils/previous-feed.ts` use relative imports.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/); branches follow [Conventional Branch](https://conventional-branch.github.io) short form (`feat/...`, `fix/...`).
- Do not commit to Renovate PRs.
- When commands, the feed list or the output layout change, update `README.md` and this file.

## Security

- Never commit secrets. The only secret is `DISCORD_WEBHOOK` in GitHub Actions.
- Do not log credentials or personal information.
- `pnpm start` sends real requests to third-party sites and to GitHub Pages; avoid running it repeatedly.
