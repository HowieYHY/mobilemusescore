# PocketScore: notes for a delegated agent (Codex)

You are given one task at a time by the lead agent (Claude), which reviews and integrates your work. The
project's own rules are in [CLAUDE.md](CLAUDE.md); read its "Standing requirements" before changing app code.
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) describes the architecture, the build and the tests.

- **Never commit, push, publish, bump the version or run `scripts/deploy-pages.sh`.** Leave changes in the
  working folder for review.
- Stay inside the task's files. Don't touch `third_party/`, `build/ghpages/`, `app/public/engine/` or
  `real test musescore*/`.
- Don't use a phone over adb and don't run the `android-*` tests.
- One block of code for every platform: no device or browser checks around a fix.
- A change to behaviour comes with a test that fails without it; say which test and show its result.
- App code: TypeScript in `app/src` (`cd app && npx tsc --noEmit` must pass). Tests are Node scripts in
  `scripts/`; browser tests need the dev server (`cd app && npx vite --port 5180 --host 127.0.0.1`) and take
  `APP_URL`. On this PC the test scores are in `real test musescore files/`.
- Write plainly, in the style of the surrounding comments and docs.
- Finish with: files changed, checks run with their results, and anything that blocked you.
