# Changesets

Run `pnpm changeset` to add a release note for user-facing package changes.

The release workflow opens a `Version Packages` pull request from the pending
changesets on `main`. Merging that PR triggers the gated npm publish workflow.
