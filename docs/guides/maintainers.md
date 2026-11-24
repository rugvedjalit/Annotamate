# Maintainer guide

How the repository is protected, how contributions reach `main` and how a release is published.
Contributors only need [CONTRIBUTING.md](../../CONTRIBUTING.md); this guide is for the people who
review, merge and release.

## In short

| Threat | What stops it |
| --- | --- |
| Someone rewrites or deletes `main` | Ruleset *main: no force pushes or deletion*: no force pushes, no deletion, linear history. **Nobody can bypass it, administrators included.** |
| Unreviewed code lands on `main` | Ruleset *main: pull requests, review and checks*: changes arrive through a pull request with a code owner's approval and green checks. |
| A contributor's pull request runs code with the project's credentials | Workflows from forks get a read-only token and no secrets, and wait for a maintainer's approval before they run at all. |
| Someone publishes a release, an image or a package under this project's name | Only maintainers can create `v*` tags; the release workflow refuses tags that are not on `main` and does not run in forks; publishing waits for a maintainer's approval in the `release` and `pypi` environments. |
| A compromised or replaced third-party action | Every action is pinned to a full commit SHA (GitHub enforces this), only actions from GitHub, Docker and PyPA may run, and Dependabot proposes updates weekly. |
| A vulnerable or incompatibly licensed dependency | *Dependency review* on every pull request, Dependabot alerts and security updates. |
| A vulnerability in the code | *CodeQL* on every pull request and weekly; the ruleset blocks merges that add high or critical alerts. |
| A leaked token or password | Secret scanning with push protection rejects pushes that contain credentials. |

All of this is configuration kept in the repository and applied with one script, so every change
to it is reviewed like code (see [Changing the settings](#changing-the-settings)).

## Who can do what

| | Anyone | Collaborator (write) | Maintainer (admin) |
| --- | --- | --- | --- |
| Open issues and pull requests (from a fork) | Yes | Yes | Yes |
| Push branches to this repository | No | Yes, except `main` | Yes |
| Merge a pull request into `main` | No | With an approving code-owner review and green checks | Yes |
| Push directly to `main` | No | No | Yes, fast-forward only (see [Merging](#merging)) |
| Force-push to or delete `main` | No | No | **No** |
| Create, move or delete a `v*` tag | No | No | Yes |
| Approve a deployment to `release` or `pypi` | No | No | Yes |
| Change these settings | No | No | Yes |

Code owners are listed in [`.github/CODEOWNERS`](../../.github/CODEOWNERS). Security-sensitive
paths (workflows, the container and deployment files, dependency manifests, authentication, path
checks, uploads and database migrations) are listed separately, so that a future co-maintainer for
general code does not automatically gain approval rights over them.

## Rulesets

The files in [`.github/rulesets/`](../../.github/rulesets/) are exactly what GitHub enforces:

- **`main-history.json`, *main: no force pushes or deletion*.** Applies to the default branch with
  no bypass for anyone. History on `main` is never rewritten; a bad change is undone with a new
  commit (`git revert`).
- **`main-review.json`, *main: pull requests, review and checks*.** Every change needs a pull
  request with:
  - one approving review from a code owner, given after the last push (a new push dismisses earlier
    approvals, and the person who pushed last cannot approve their own push);
  - every review conversation resolved;
  - these checks green on a branch that is up to date with `main`: the two backend jobs, the
    benchmark, the frontend, the package, the end-to-end tests, the Docker image, *Dependency
    review* and the three *CodeQL* jobs;
  - no new CodeQL alert of high or critical severity, and no CodeQL error;
  - squash or rebase as the merge method (no merge commits).

  Repository administrators may bypass this ruleset (not the first one). That is what lets the
  maintainer merge their own pull requests, which nobody else can approve in a one-maintainer
  project.
- **`release-tags.json`, *Release tags: maintainers only*.** Creating, moving or deleting a tag
  matching `v*` is reserved for administrators, because pushing such a tag starts a release.

## Pull requests from forks

Outside contributors cannot push to this repository; they fork it and open a pull request. For
those pull requests:

- workflows run only after a maintainer clicks **Approve and run** (setting *Require approval for
  all external contributors*). **Read the diff first**, in particular any change under `.github/`,
  `scripts/`, `web/package*.json`, `pyproject.toml`, `Dockerfile` or test fixtures, because the
  workflow runs the pull request's code;
- the token is read-only and no secrets are passed, whatever the workflow file says;
- no workflow uses `pull_request_target` or `workflow_run`, the two triggers that would run with
  this repository's permissions. Keep it that way: a change that adds one needs a very good reason
  and a careful review.

## Reviewing

1. Check that the pull request does one thing, follows the [conventions](../../CONTRIBUTING.md) and
   has tests for new behaviour.
2. Read changes to workflows, dependencies and security-sensitive code line by line. A new
   dependency must be necessary, maintained, and MIT-compatible.
3. Wait for all required checks. Never approve a workflow run from a fork without reading it.
4. Request changes, or approve. A push after your approval dismisses it, so review the last
   version.

## Merging

Merge with **Squash and merge** for a pull request whose commits are work in progress, or **Rebase
and merge** for a series of clean, conventional commits. The branch is deleted automatically.

The maintainer may also fast-forward `main` to a reviewed branch whose checks are green, which keeps
the original commits (author and committer) byte for byte:

```bash
git fetch origin
git push origin origin/feat/some-change:refs/heads/main   # refused unless it is a fast-forward
```

GitHub marks the pull request as merged. Do this only for a branch that is up to date with `main`
and whose pull request shows every required check green.

## Releasing

1. Open a pull request that sets the version in `annotamate/__init__.py` and `web/package.json` and
   moves the *Unreleased* entries of `CHANGELOG.md` under the new version. Merge it.
2. Tag the merged commit on `main` and push the tag (maintainers only):

   ```bash
   git switch main && git pull --ff-only
   git tag -a v2.1.0 -m "Annotamate 2.1.0"
   git push origin v2.1.0
   ```

3. The *Release* workflow builds and checks the distributions, then waits. Open the run under
   **Actions** and approve the `release` deployment (and `pypi`, if PyPI publishing is enabled).
   Only then are the GitHub release, the container image (with build provenance and an SBOM) and
   the PyPI package published.

The workflow fails before publishing anything if the tag does not point to a commit on `main`, if
it does not match the package version, or if it runs anywhere but `rugvedjalit/Annotamate`.

## Changing the settings

The settings are applied by [`scripts/apply_repo_settings.py`](../../scripts/apply_repo_settings.py)
with the GitHub CLI, signed in as an administrator. It is idempotent:

```bash
python scripts/apply_repo_settings.py --dry-run   # print every request without sending it
python scripts/apply_repo_settings.py             # apply
```

To change a rule, edit the JSON file or the constants at the top of the script in a pull request,
merge it, then run the script. Besides the rulesets it sets:

- **merges:** squash and rebase only, branches deleted after merging, auto-merge allowed;
- **security:** Dependabot alerts and security updates, secret scanning with push protection, and
  private vulnerability reporting (the *Report a vulnerability* button used by
  [SECURITY.md](../../SECURITY.md));
- **Actions:** only GitHub-owned actions plus `docker/*` and `pypa/gh-action-pypi-publish`,
  full-SHA pinning required, a read-only default token that cannot approve pull requests, and
  approval required for every workflow run from an external contributor;
- **environments:** `release` and `pypi`, deployable from `v*` tags only, each waiting for a
  maintainer's approval.

When a required check is renamed or added in a workflow, update `main-review.json` in the same pull
request and run the script after merging, or pull requests will wait for a check that never runs.

### Adding an action

Pin it to the full commit SHA of a release and keep the version as a comment, as in the existing
workflows, so Dependabot can update it:

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

An action from another publisher must also be added to `patterns_allowed` in the script.

## Access hygiene

Review occasionally under **Settings**: collaborators and their roles, deploy keys, webhooks,
installed GitHub Apps, and Actions secrets. At the time of writing there are no deploy keys,
webhooks or repository secrets: releases authenticate with the short-lived workflow token and PyPI
trusted publishing, so there is no long-lived credential to steal. Keep two-factor authentication
on for every account with write access.
