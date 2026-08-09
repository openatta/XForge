[简体中文](docs/RELEASING.zh-CN.md) | English

# Releasing XForge

This runbook releases `@xforge/cli` without storing npm credentials or personal
identity in the repository. The automated path uses npm trusted publishing from
GitHub Actions. Never commit an OTP, npm token, personal email, local home path,
device name, private IP address, `.npmrc`, environment file, or private key.

## One-time setup

1. Enable **Keep my email addresses private** in GitHub and configure this clone
   with your GitHub-provided noreply address. Do not put the real address in a
   tracked file:

   ```sh
   git config --local user.name "<github-login>"
   git config --local user.email "<github-id>+<github-login>@users.noreply.github.com"
   npm run privacy:install-hook
   ```

2. In the npm settings for `@xforge/cli`, add a GitHub Actions trusted publisher:

   - organization or user: `openatta`
   - repository: `XForge`
   - workflow: `publish-npm.yml`
   - environment: leave empty unless the workflow is later assigned one

   Do not create an `NPM_TOKEN` GitHub secret. The workflow uses short-lived OIDC
   credentials and requests npm provenance.

## Prepare and validate a release

Start from a clean, current `main` checkout, then choose the next SemVer:

```sh
git switch main
git pull --ff-only
npm ci --prefix xforge
npm run release:prepare -- <version>
git diff --check
git diff
npm run release:check
```

`release:prepare` updates the package, CLI, tests, documentation, Scaffold
identity, built integrity, and Scaffold checksums. It does not commit, tag, push,
or publish. Review every change before continuing.

Commit and create an annotated release tag with the noreply identity:

```sh
git add --all
npm run check:privacy -- --staged --check-next-commit
git commit -m "chore: release XForge v<version>"
git tag -a "v<version>" -m "XForge v<version>"
npm run release:check -- --require-tag
git push origin main
git push origin "v<version>"
```

## Publish

Open the repository's **Publish npm package** workflow, select the `v<version>`
tag as the run reference, and select an npm channel:

- `next` for a preview or staged rollout;
- `latest` for the stable default installed by npm.

The workflow refuses an untagged or inconsistent build, runs the privacy scan
and complete test suite, inspects the npm file list, then publishes with
provenance. It contains no persistent npm credential.

Verify the registry from a clean temporary project:

```sh
npm view @xforge/cli@<version> name version dist-tags dist.integrity
npm install --save-exact @xforge/cli@<version>
npx xforge version
```

Optionally create GitHub release notes after the npm verification:

```sh
gh release create "v<version>" --generate-notes --verify-tag
```

If a release is wrong, do not reuse its version. Deprecate the affected npm
version or move a distribution tag as appropriate, fix the source, and publish a
new version.

## Privacy controls

- `npm run check:privacy` scans tracked and unignored files without printing the
  matched values.
- `npm run privacy:install-hook` installs the repository's pre-commit check.
- `.github/workflows/privacy-check.yml` checks new commit identities and content.
- `.github/workflows/publish-npm.yml` repeats the check before publication.

The automated scan is a backstop, not permission to add real personal or secret
data to examples. Use `example.test`, placeholders, and GitHub noreply identities.
