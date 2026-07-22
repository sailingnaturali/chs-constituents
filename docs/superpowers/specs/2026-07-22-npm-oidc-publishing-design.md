# npm OIDC publishing

Publish the initial `0.1.0` manually with npm 2FA, then create `v0.1.0` on GitHub.
Afterward, add a release-triggered GitHub Actions workflow using OIDC. Configure that
workflow as npm's trusted publisher so future GitHub releases publish without an npm token.

The initial release precedes the workflow, preventing it from attempting to republish `0.1.0`.
