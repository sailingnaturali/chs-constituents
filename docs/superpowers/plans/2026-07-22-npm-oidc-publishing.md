# npm OIDC publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) superpowers:executing-plans implement plan task-by-task.

**Goal:** Publish the initial package, then enable tokenless npm publishing for later GitHub releases.

**Architecture:** The first version is published locally with npm 2FA because npm cannot trust a package that does not yet exist. A release-triggered GitHub Actions workflow is added only afterward; npm links that workflow as its trusted publisher.

**Tech Stack:** npm, GitHub Releases, GitHub Actions OIDC.

## Global Constraints

- Publish `@sailingnaturali/chs-constituents@0.1.0` publicly.
- Do not store npm credentials or an `NPM_TOKEN` in the repository.

### Task 1: Publish the initial package and release

**Files:**

- Verify: `package.json`

**Interfaces:**

- Consumes: npm account with package-publishing rights and a current 2FA code.
- Produces: `@sailingnaturali/chs-constituents@0.1.0` on npm and GitHub release `v0.1.0`.

- [ ] **Step 1: Verify package contents**

  Run: `npm pack --dry-run`
  Expected: package contains only `dist` artifacts declared by `files`.

- [ ] **Step 2: Publish with the current 2FA code**

  Run: `npm publish --otp=<current-code>`
  Expected: `+ @sailingnaturali/chs-constituents@0.1.0`.

- [ ] **Step 3: Create the matching GitHub release before the workflow exists**

  Run: `gh release create v0.1.0 --target main --title v0.1.0 --generate-notes`
  Expected: GitHub displays the published `v0.1.0` release without a duplicate npm-publish job.

### Task 2: Add trusted publishing for future releases

**Files:**

- Create: `.github/workflows/publish.yml`

**Interfaces:**

- Consumes: a published npm package and GitHub release `published` event.
- Produces: a provenance-backed `npm publish` using GitHub Actions OIDC.

- [ ] **Step 1: Add the release workflow**

  Create `.github/workflows/publish.yml`:

  ```yaml
  name: publish
  on:
    release:
      types: [published]
  permissions:
    contents: read
    id-token: write
  jobs:
    publish:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v5
        - uses: actions/setup-node@v5
          with:
            node-version: 24
            registry-url: https://registry.npmjs.org
        - run: npm ci
        - run: npm run build
        - run: npm test
        - run: npm publish
  ```

- [ ] **Step 2: Verify the workflow's local commands**

  Run: `npm ci && npm run build && npm test`
  Expected: build and all tests exit zero.

- [ ] **Step 3: Commit and push the workflow**

  Run: `git add .github/workflows/publish.yml && git commit -m "ci: publish npm releases with OIDC" && git push origin main`
  Expected: `main` contains the workflow.

- [ ] **Step 4: Register the trusted publisher in npm**

  In npmjs.com package settings, choose **Trusted Publisher → GitHub Actions** and enter repository `sailingnaturali/chs-constituents`, workflow filename `publish.yml`, with no environment.
  Expected: the npm package displays the connected GitHub Actions publisher.

## Self-review

- The initial manual publish precedes both the GitHub release and OIDC setup, so the release cannot republish `0.1.0`.
- The future workflow checks out, installs, builds, tests, and publishes without a token.
