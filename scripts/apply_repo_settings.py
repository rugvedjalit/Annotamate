"""Apply the repository's protection settings on GitHub.

Rulesets, environments, merge settings and security features are configuration, so they live in
the repository as reviewable files (``.github/rulesets/*.json``) and this script makes GitHub match
them. It is idempotent: run it again after changing a file and only the differences are applied.

Needs the GitHub CLI (``gh``), signed in as a repository administrator::

    python scripts/apply_repo_settings.py --dry-run     # show what would be sent
    python scripts/apply_repo_settings.py               # apply

See docs/guides/maintainers.md for what each setting protects against.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
RULESETS = ROOT / ".github" / "rulesets"
DEFAULT_REPO = "rugvedjalit/Annotamate"

# Repository settings (PATCH /repos/{repo}).
REPOSITORY = {
    # Linear history: no merge commits. Squash or rebase only.
    "allow_merge_commit": False,
    "allow_squash_merge": True,
    "allow_rebase_merge": True,
    "squash_merge_commit_title": "PR_TITLE",
    "squash_merge_commit_message": "PR_BODY",
    "allow_auto_merge": True,
    "allow_update_branch": True,
    "delete_branch_on_merge": True,
    "web_commit_signoff_required": False,
    "security_and_analysis": {
        "secret_scanning": {"status": "enabled"},
        "secret_scanning_push_protection": {"status": "enabled"},
        "secret_scanning_non_provider_patterns": {"status": "enabled"},
        "dependabot_security_updates": {"status": "enabled"},
    },
}

# GitHub Actions: which actions may run, and how much the workflow token may do.
ACTIONS_PERMISSIONS = {"enabled": True, "allowed_actions": "selected", "sha_pinning_required": True}
ACTIONS_SELECTED = {
    "github_owned_allowed": True,
    "verified_allowed": False,
    "patterns_allowed": ["docker/*", "pypa/gh-action-pypi-publish@*"],
}
ACTIONS_WORKFLOW = {"default_workflow_permissions": "read", "can_approve_pull_request_reviews": False}
# Workflows from forks wait for a maintainer's approval unless the author is a collaborator.
FORK_PR_APPROVAL = {"approval_policy": "all_external_contributors"}

# Deployment environments used by .github/workflows/release.yml. Both accept `v*` tags only
# and wait for a maintainer to approve the deployment.
ENVIRONMENTS = ["release", "pypi"]
ENVIRONMENT_TAG_PATTERN = "v*"


class Gh:
    def __init__(self, repo: str, dry_run: bool) -> None:
        self.repo = repo
        self.dry_run = dry_run

    def get(self, path: str) -> Any:
        out = subprocess.run(
            ["gh", "api", "-H", "Accept: application/vnd.github+json", path],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        return json.loads(out) if out.strip() else None

    def send(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        print(f"{method} {path}")
        if self.dry_run:
            if body is not None:
                print(json.dumps(body, indent=2))
            return None
        cmd = ["gh", "api", "-X", method, "-H", "Accept: application/vnd.github+json", path]
        if body is not None:
            cmd += ["--input", "-"]
        result = subprocess.run(
            cmd, input=json.dumps(body) if body is not None else None, capture_output=True, text=True
        )
        if result.returncode != 0:
            sys.exit(f"{method} {path} failed:\n{result.stdout}{result.stderr}")
        return json.loads(result.stdout) if result.stdout.strip() else None

    def r(self, path: str = "") -> str:
        return f"repos/{self.repo}{path}"


def apply_repository(gh: Gh) -> None:
    gh.send("PATCH", gh.r(), REPOSITORY)
    gh.send("PUT", gh.r("/vulnerability-alerts"))
    gh.send("PUT", gh.r("/automated-security-fixes"))
    gh.send("PUT", gh.r("/private-vulnerability-reporting"))


def apply_actions(gh: Gh) -> None:
    gh.send("PUT", gh.r("/actions/permissions"), ACTIONS_PERMISSIONS)
    gh.send("PUT", gh.r("/actions/permissions/selected-actions"), ACTIONS_SELECTED)
    gh.send("PUT", gh.r("/actions/permissions/workflow"), ACTIONS_WORKFLOW)
    gh.send("PUT", gh.r("/actions/permissions/fork-pr-contributor-approval"), FORK_PR_APPROVAL)


def apply_rulesets(gh: Gh) -> None:
    existing = {rs["name"]: rs["id"] for rs in gh.get(gh.r("/rulesets?per_page=100")) or []}
    for path in sorted(RULESETS.glob("*.json")):
        body = json.loads(path.read_text(encoding="utf-8"))
        ruleset_id = existing.get(body["name"])
        if ruleset_id is None:
            gh.send("POST", gh.r("/rulesets"), body)
        else:
            gh.send("PUT", gh.r(f"/rulesets/{ruleset_id}"), body)


def apply_environments(gh: Gh) -> None:
    owner = gh.repo.split("/")[0]
    reviewer_id = gh.get(f"users/{owner}")["id"]
    for name in ENVIRONMENTS:
        gh.send(
            "PUT",
            gh.r(f"/environments/{name}"),
            {
                "wait_timer": 0,
                "prevent_self_review": False,
                "reviewers": [{"type": "User", "id": reviewer_id}],
                "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
            },
        )
        policies_path = gh.r(f"/environments/{name}/deployment-branch-policies")
        policies = [] if gh.dry_run and not _exists(gh, name) else gh.get(policies_path)["branch_policies"]
        wanted = (ENVIRONMENT_TAG_PATTERN, "tag")
        for policy in policies:
            if (policy["name"], policy.get("type", "branch")) != wanted:
                gh.send("DELETE", f"{policies_path}/{policy['id']}")
        if not any((p["name"], p.get("type", "branch")) == wanted for p in policies):
            gh.send("POST", policies_path, {"name": ENVIRONMENT_TAG_PATTERN, "type": "tag"})


def _exists(gh: Gh, environment: str) -> bool:
    names = [e["name"] for e in gh.get(gh.r("/environments"))["environments"]]
    return environment in names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"owner/name (default {DEFAULT_REPO})")
    parser.add_argument("--dry-run", action="store_true", help="print the requests without sending them")
    args = parser.parse_args()

    gh = Gh(args.repo, args.dry_run)
    apply_repository(gh)
    apply_actions(gh)
    apply_rulesets(gh)
    apply_environments(gh)
    print("dry run: nothing was changed" if args.dry_run else "done")


if __name__ == "__main__":
    main()
