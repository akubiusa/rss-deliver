# Copilot review instructions

Follow `AGENTS.md` at the repository root. It describes the project, commands, structure and conventions.

## Review checklist

- HTTP uses the built-in `fetch`; flag a new HTTP client dependency such as `axios`.
- Flag a new `any`, enabling `skipLibCheck`, and `@ts-ignore` / `@ts-expect-error` that hides a type error.
- A service's `collect()` should not make the whole run fail, and errors must not be swallowed while reporting success.
- Services must not reimplement `pubDate` fallback or deleted-article tracking (`BaseService.processPubDates()`, `deleted-articles-tracker`).
- A new service must be registered in the `services` array in `src/main.ts`.
- No secrets or personal information in code, logs or commits.
- Do not flag as problems: no build step (`tsx` runs the TypeScript directly), no test framework, the `.article-cache` file cache, or the platform-limited `canvas` / `sharp` binaries (`pnpm.supportedArchitectures`).
- Formatting and lint findings are enforced by CI; prefer substantive issues.

## Language

Write review comments, code comments, docstrings, documentation, commit messages and PR text in English. Runtime messages (logs, errors) are English. Japanese feed content, fixtures and external text are kept as is.
