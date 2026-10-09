# TODO: re-enable the disabled workflows

This fork (RTL for Blake2b) inherited five GitHub Actions workflows from upstream RTL. Three of them need secrets or
accounts that only upstream has, and one is a bot tied to upstream's GitHub App. Their automatic triggers were removed
so they stop failing; the files are kept, and each can still be started by hand where a `workflow_dispatch` is left.

| Workflow | Was triggered by | Why disabled | What is needed to re-enable |
|---|---|---|---|
| `traffic-exporter.yml` | nightly cron `0 2 * * *` | Writes repo traffic to upstream's Google Sheet; needs `GOOGLE_SHEETS_CREDENTIALS` and `GH_TOKEN` | Decide whether we want it at all. If yes: create our own sheet and service account, add both secrets, restore the `schedule:` block. Otherwise delete the workflow and `.github/scripts/export_traffic.py`. |
| `docker-release.yml` | push of a `v*` tag | Logs in to Docker Hub with `DOCKER_USERNAME` and `DOCKER_PASSWORD` and pushes upstream's image names | Pick a registry (Docker Hub or ghcr.io), change the image names, add the secrets, restore the `push: tags: [ 'v*' ]` trigger. |
| `ci.yml` ("Artifact") | push of a `v*` tag, and a published release | Builds the release artifact; not yet checked against this fork's release process | Run it once with `workflow_dispatch` on a test version, confirm the artifact is correct, then restore the `push: tags` and `release: types: [released]` triggers. |
| `rtlreviewbot.yml` | PR comments and review requests | Calls `Ride-The-Lightning/rtlreviewbot-action` with upstream's GitHub App id and `GATEWAY_*` and `ANTHROPIC_API_KEY` secrets | Needs our own review bot, or delete the workflow. Do not point it at upstream's app. |

Still active: `checks.yml` ("Lint & Test"). It now also runs on every pull request to `master` and `Release-*`.

When a workflow is re-enabled, remove its `DISABLED in this fork` comment and delete its row here. Delete this file when
the table is empty.
