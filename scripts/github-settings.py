#!/usr/bin/env python3
"""Desired GitHub repository settings as code: supply-chain hardening for this repo.

usage: github-settings.py [--repo OWNER/NAME] [--print-plan | --check | --apply] [--prune]

  --print-plan  (default) print the plan as JSON; makes NO network call
  --check       compare the live settings with the plan (read-only gh api calls); exit 1 on drift
  --apply       write the settings (needs admin rights on the repository: `gh auth status`)
  --prune       with --apply: replace the Actions allow-list instead of adding to it

What it enforces, and why:
  * Actions: only the actions pinned in .github/workflows/*.yml (plus the pinned actions that
    composite actions call themselves, TRANSITIVE_PINS) may run, each by its exact
    full commit SHA ("owner/repo@<40 hex>"), nothing GitHub-owned or "verified" by default,
    and `sha_pinning_required` makes GitHub reject a workflow that references a tag.
    A Dependabot bump of an action therefore fails CI until a maintainer has reviewed it and run
    `scripts/github-settings.py --apply` from that branch (the allow-list is the approval).
  * The workflow token is read-only by default; workflows ask for more per job. Creating
    release pull requests needs `can_approve_pull_request_reviews` (release-please).
  * Workflow runs of first-time contributors need approval (bot runs such as release-please are not blocked).
  * Secret scanning with push protection, Dependabot alerts and security updates, private
    vulnerability reporting, CodeQL default setup for JavaScript/TypeScript.
  * Rulesets: the default branch cannot be deleted or force-pushed; release tags `v*` cannot be
    moved, deleted or re-created once published.
  * Squash merges only, with the PR title as commit message (Conventional Commits drive
    release-please), branches deleted after merge, no wiki/projects/discussions.

Rulesets are matched by name, so re-running is idempotent. Python standard library only; the
only external program is `gh`. Nothing secret is read or printed.
"""

import argparse
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<ref>[^\s#]+)", re.M)
PINNED = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$")


def workflow_pins() -> list[str]:
	"""Every `uses:` reference of the workflows; local (./) and docker:// references are not allowed here."""
	pins: set[str] = set()
	for path in sorted(WORKFLOWS.glob("*.y*ml")):
		for match in USES.finditer(path.read_text()):
			ref = match.group("ref").strip("'\"")
			if not PINNED.match(ref):
				raise SystemExit(f"{path.name}: `uses: {ref}` is not pinned to a full commit SHA")
			pins.add(ref)
	if not pins:
		raise SystemExit("no workflow actions found: refusing to build an empty allow-list")
	return sorted(pins)


# Actions that composite actions in our workflows call themselves. GitHub checks these against the
# allow-list too (and refused the first release run for exactly this reason). Keyed by the EXACT pin
# of the wrapper in the workflows; the value is the nested pin that wrapper uses. When Dependabot bumps
# the wrapper, the key no longer matches the workflow and tests/github-settings.test.ts fails until the
# nested pin is re-resolved (and this entry replaced):
#   gh api "repos/<owner>/<repo>/contents/action.yml?ref=<sha>" --jq .content | base64 -d | grep uses:
TRANSITIVE_PINS = {
	# actions/attest-build-provenance v4.2.2 nests actions/attest v4.2.1 (itself a node action)
	"actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8": "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
}


def nested_pins(pins: list[str]) -> list[str]:
	"""The nested pins of those wrappers whose exact pin is in `pins`."""
	return sorted(nested for wrapper, nested in TRANSITIVE_PINS.items() if wrapper in pins)


def plan() -> dict:
	pins = workflow_pins()
	return {
		"repository": {
			"has_wiki": False,
			"has_projects": False,
			"has_discussions": False,
			"has_issues": True,
			"allow_squash_merge": True,
			"allow_merge_commit": False,
			"allow_rebase_merge": False,
			"allow_auto_merge": False,
			"delete_branch_on_merge": True,
			"squash_merge_commit_title": "PR_TITLE",
			"squash_merge_commit_message": "PR_BODY",
			"web_commit_signoff_required": False,
			"security_and_analysis": {
				"secret_scanning": {"status": "enabled"},
				"secret_scanning_push_protection": {"status": "enabled"},
			},
		},
		"topics": ["streamdeck", "stream-deck-plugin", "weather-station", "netatmo"],
		"actions_permissions": {"enabled": True, "allowed_actions": "selected", "sha_pinning_required": True},
		"selected_actions": {
			"github_owned_allowed": False,
			"verified_allowed": False,
			"patterns_allowed": sorted(set(pins) | set(nested_pins(pins))),
		},
		"transitive_pins": {wrapper: nested for wrapper, nested in TRANSITIVE_PINS.items() if wrapper in pins},
		"workflow_permissions": {"default_workflow_permissions": "read", "can_approve_pull_request_reviews": True},
		"fork_pr_approval": {"approval_policy": "first_time_contributors"},
		"toggles": {
			"vulnerability-alerts": "PUT",
			"automated-security-fixes": "PUT",
			"private-vulnerability-reporting": "PUT",
		},
		"code_scanning_default_setup": {"state": "configured", "languages": ["javascript-typescript"], "query_suite": "default"},
		"rulesets": [
			{
				"name": "protect-default-branch",
				"target": "branch",
				"enforcement": "active",
				"conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
				"rules": [{"type": "deletion"}, {"type": "non_fast_forward"}],
				"bypass_actors": [],
			},
			{
				"name": "protect-release-tags",
				"target": "tag",
				"enforcement": "active",
				"conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
				"rules": [{"type": "deletion"}, {"type": "non_fast_forward"}, {"type": "update"}],
				"bypass_actors": [],
			},
		],
	}


def gh(args: list[str], body: dict | None = None, check: bool = True) -> tuple[int, str]:
	cmd = ["gh", "api", *args]
	if body is not None:
		cmd += ["--input", "-"]
	proc = subprocess.run(cmd, input=json.dumps(body) if body is not None else None, capture_output=True, text=True)
	if check and proc.returncode != 0:
		raise SystemExit(f"gh api {' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}")
	return proc.returncode, proc.stdout


def get_json(path: str) -> dict | list | None:
	code, out = gh([path], check=False)
	if code != 0 or not out.strip():
		return None
	return json.loads(out)


def current_repo() -> str:
	proc = subprocess.run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], capture_output=True, text=True)
	if proc.returncode != 0:
		raise SystemExit("cannot determine the repository: pass --repo OWNER/NAME")
	return proc.stdout.strip()


def apply(repo: str, p: dict, prune: bool) -> None:
	base = f"repos/{repo}"
	gh(["-X", "PATCH", base], p["repository"])
	gh(["-X", "PUT", f"{base}/topics"], {"names": p["topics"]})
	gh(["-X", "PUT", f"{base}/actions/permissions"], p["actions_permissions"])
	selected = dict(p["selected_actions"])
	if not prune:
		live = get_json(f"{base}/actions/permissions/selected-actions") or {}
		selected["patterns_allowed"] = sorted(set(selected["patterns_allowed"]) | set(live.get("patterns_allowed", [])))
	gh(["-X", "PUT", f"{base}/actions/permissions/selected-actions"], selected)
	gh(["-X", "PUT", f"{base}/actions/permissions/workflow"], p["workflow_permissions"])
	gh(["-X", "PUT", f"{base}/actions/permissions/fork-pr-contributor-approval"], p["fork_pr_approval"])
	for name, method in p["toggles"].items():
		gh(["-X", method, f"{base}/{name}"])
	code, out = gh(["-X", "PATCH", f"{base}/code-scanning/default-setup"], p["code_scanning_default_setup"], check=False)
	if code != 0:
		print(f"warning: CodeQL default setup not applied: {out.strip()[:200]}", file=sys.stderr)
	existing = {r["name"]: r["id"] for r in (get_json(f"{base}/rulesets") or [])}
	for ruleset in p["rulesets"]:
		if ruleset["name"] in existing:
			gh(["-X", "PUT", f"{base}/rulesets/{existing[ruleset['name']]}"], ruleset)
		else:
			gh(["-X", "POST", f"{base}/rulesets"], ruleset)


def check(repo: str, p: dict) -> list[str]:
	base = f"repos/{repo}"
	drift: list[str] = []
	live = get_json(base) or {}
	for key, want in p["repository"].items():
		if key == "security_and_analysis":
			have = live.get(key, {})
			for feature, spec in want.items():
				got = have.get(feature, {}).get("status")
				if got != spec["status"]:
					drift.append(f"{feature}: {got} != {spec['status']}")
		elif live.get(key) != want:
			drift.append(f"{key}: {live.get(key)!r} != {want!r}")
	if sorted(live.get("topics", [])) != sorted(p["topics"]):
		drift.append("topics differ")
	for path, want in (
		("actions/permissions", p["actions_permissions"]),
		("actions/permissions/workflow", p["workflow_permissions"]),
		("actions/permissions/fork-pr-contributor-approval", p["fork_pr_approval"]),
	):
		have = get_json(f"{base}/{path}") or {}
		for key, value in want.items():
			if have.get(key) != value:
				drift.append(f"{path}.{key}: {have.get(key)!r} != {value!r}")
	have = get_json(f"{base}/actions/permissions/selected-actions") or {}
	if have.get("github_owned_allowed") is not False or have.get("verified_allowed") is not False:
		drift.append("selected-actions: github-owned/verified actions are allowed")
	extra = set(have.get("patterns_allowed", [])) - set(p["selected_actions"]["patterns_allowed"])
	missing = set(p["selected_actions"]["patterns_allowed"]) - set(have.get("patterns_allowed", []))
	if missing:
		drift.append(f"allow-list lacks: {sorted(missing)}")
	if extra:
		drift.append(f"allow-list has pins no workflow uses (run --apply --prune): {sorted(extra)}")
	names = {r["name"] for r in (get_json(f"{base}/rulesets") or [])}
	for ruleset in p["rulesets"]:
		if ruleset["name"] not in names:
			drift.append(f"ruleset missing: {ruleset['name']}")
	return drift


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
	parser.add_argument("--repo")
	mode = parser.add_mutually_exclusive_group()
	mode.add_argument("--print-plan", action="store_true")
	mode.add_argument("--check", action="store_true")
	mode.add_argument("--apply", action="store_true")
	parser.add_argument("--prune", action="store_true")
	args = parser.parse_args()
	p = plan()
	if args.apply:
		repo = args.repo or current_repo()
		apply(repo, p, args.prune)
		print(f"applied to {repo}")
		return 0
	if args.check:
		repo = args.repo or current_repo()
		drift = check(repo, p)
		for line in drift:
			print(f"DRIFT {line}")
		print(f"{repo}: {'no drift' if not drift else f'{len(drift)} difference(s)'}")
		return 1 if drift else 0
	print(json.dumps(p, indent=2))
	return 0


if __name__ == "__main__":
	sys.exit(main())
