# Releasing

1. Confirm that CHANGELOG.md is updated (any new changes should go under "Unreleased" at the top).
2. Merge to `main`: the **Deploy production** workflow validates, builds and deploys the image by digest.
3. Without GitHub Actions, follow [DEPLOYMENT.md "Manual release"](docs/DEPLOYMENT.md#manual-release-github-actions-unavailable).
