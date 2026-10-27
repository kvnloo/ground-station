#!/usr/bin/env python3
"""Safely promote a Ground Station release through Drone, GHCR, and GitHub.

Prerequisites (all verified by preflight before anything is written):
- git, python3, docker, and gh installed; `gh auth login` completed.
- Git author identity (user.name/user.email) configured.
- A clean worktree on the release branch, with local HEAD, the build remote
  branch, and the publish remote branch all identical (for a new release).
- Push credentials work for BOTH remotes (probed with `git push --dry-run`).
- GitHub Tests passed for HEAD (unless --skip-ci-check).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parent.parent
VERSION_PATH = ROOT / "backend/server/version.json"
README_PATH = ROOT / "README.md"
VERSION_RE = re.compile(r"^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
CHANGELOG_ENTRY_RE = re.compile(r"^\* \*\*(v\d+\.\d+\.\d+) \(\d{4}-\d{2}-\d{2}\):\*\* .+$")
DEFAULT_IMAGE = "ghcr.io/sgoudelis/ground-station"
DEFAULT_GITHUB_REPO = "sgoudelis/ground-station"
ABSENT_MANIFEST_MESSAGES = (
    "manifest unknown",
    "no such manifest",
    "not found",
)


class ReleaseError(RuntimeError):
    """A release invariant was not satisfied."""


def log(message: str) -> None:
    print(f"[release] {message}", flush=True)


def command_text(command: Sequence[str]) -> str:
    """Render commands for logs without invoking a shell."""
    return " ".join(repr(part) if any(char.isspace() for char in part) else part for part in command)


def run(
    command: Sequence[str],
    *,
    check: bool = True,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        list(command),
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
    )
    if check and result.returncode != 0:
        details = "\n".join(
            value.strip() for value in (result.stdout or "", result.stderr or "") if value.strip()
        )
        suffix = f"\n{details}" if details else ""
        raise ReleaseError(f"Command failed: {command_text(command)}{suffix}")
    return result


def output(command: Sequence[str]) -> str:
    return run(command, capture=True).stdout.strip()


def git(*arguments: str) -> str:
    return output(("git", *arguments))


def require_commands(commands: Sequence[str]) -> None:
    missing = [command for command in commands if shutil.which(command) is None]
    if missing:
        raise ReleaseError(f"Required commands are missing: {', '.join(missing)}")


def ensure_git_identity() -> None:
    """Fail before writing release files if commits would be impossible or anonymous."""
    for key in ("user.name", "user.email"):
        configured = run(("git", "config", "--get", key), check=False, capture=True)
        if configured.returncode != 0 or not configured.stdout.strip():
            raise ReleaseError(
                f"Git {key} is not configured; release commits need an author identity. "
                f"Fix with: git config --global {key} \"...\""
            )


def ensure_github_auth() -> None:
    result = run(("gh", "auth", "status"), check=False, capture=True)
    if result.returncode != 0:
        raise ReleaseError(
            "The GitHub CLI is not authenticated; run `gh auth login` first. "
            f"{(result.stderr or '').strip()}"
        )


def normalize_version(raw_version: str) -> tuple[str, tuple[int, int, int]]:
    match = VERSION_RE.fullmatch(raw_version.strip())
    if not match:
        raise ReleaseError("Version must contain three numeric components, for example 0.8.12")
    major, minor, patch = (int(part) for part in match.groups())
    parts = (major, minor, patch)
    return ".".join(str(part) for part in parts), parts


def read_version_file(path: Path = VERSION_PATH) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"Cannot read {path.relative_to(ROOT)}: {exc}") from exc
    value = data.get("version") if isinstance(data, dict) else None
    if not isinstance(value, str):
        raise ReleaseError(f"{path.relative_to(ROOT)} does not contain a string version")
    return normalize_version(value)[0]


def atomic_write(path: Path, content: str) -> None:
    """Replace a file atomically so interruption cannot truncate it."""
    mode = path.stat().st_mode
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_name = temporary.name
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)


def write_version_file(version: str) -> None:
    atomic_write(VERSION_PATH, json.dumps({"version": version}, indent=2) + "\n")


def normalize_release_notes(notes: str) -> str:
    normalized = " ".join(notes.split())
    if not normalized:
        raise ReleaseError("Release notes must not be empty")
    if normalized.startswith(('-', '*')):
        raise ReleaseError("Release notes must be a summary sentence, not a Markdown list")
    return normalized


def normalize_release_date(raw_date: str | None) -> str:
    if raw_date is None:
        return datetime.now().astimezone().date().isoformat()
    try:
        return date.fromisoformat(raw_date).isoformat()
    except ValueError as exc:
        raise ReleaseError("Release date must use YYYY-MM-DD format") from exc


def changelog_entries(readme: str) -> tuple[int, int, list[str]]:
    lines = readme.splitlines(keepends=True)
    try:
        heading_index = next(
            index for index, line in enumerate(lines) if line.rstrip("\r\n") == "## Recent Releases"
        )
    except StopIteration as exc:
        raise ReleaseError("README.md has no '## Recent Releases' section") from exc

    section_end = next(
        (
            index
            for index in range(heading_index + 1, len(lines))
            if lines[index].startswith("## ")
        ),
        len(lines),
    )
    section_lines = [line.rstrip("\r\n") for line in lines[heading_index + 1 : section_end]]
    entries = [line for line in section_lines if line.startswith("* **v")]
    unexpected = [line for line in section_lines if line and not line.startswith("* **v")]
    if unexpected:
        raise ReleaseError("README Recent Releases contains unexpected non-release content")
    if not entries or any(CHANGELOG_ENTRY_RE.fullmatch(entry) is None for entry in entries):
        raise ReleaseError("README Recent Releases entries do not match the expected format")
    return heading_index, section_end, entries


def render_changelog(readme: str, version: str, release_date: str, notes: str) -> tuple[str, list[str]]:
    """Insert one release entry and return the updated README plus removed entries."""
    lines = readme.splitlines(keepends=True)
    heading_index, section_end, entries = changelog_entries(readme)
    tag = f"v{version}"
    existing_tags: list[str] = []
    for existing_entry in entries:
        match = CHANGELOG_ENTRY_RE.fullmatch(existing_entry)
        if match is None:
            raise ReleaseError("README Recent Releases entries do not match the expected format")
        existing_tags.append(match.group(1))
    if tag in existing_tags:
        raise ReleaseError(f"README Recent Releases already contains {tag}")
    entry = f"* **{tag} ({release_date}):** {normalize_release_notes(notes)}"
    retained = [entry, *entries][:10]
    removed = entries[9:]
    replacement = [lines[heading_index], "\n", *(f"{item}\n" for item in retained), "\n"]
    updated = "".join([*lines[:heading_index], *replacement, *lines[section_end:]])
    return updated, removed


def validate_changelog_content(readme: str, version: str) -> None:
    _, _, entries = changelog_entries(readme)
    expected_prefix = f"* **v{version} ("
    if not entries[0].startswith(expected_prefix):
        raise ReleaseError(f"README Recent Releases does not start with v{version}")
    if len(entries) != 10:
        raise ReleaseError(f"README Recent Releases has {len(entries)} entries; expected exactly 10")


def validate_changelog(version: str) -> None:
    validate_changelog_content(README_PATH.read_text(encoding="utf-8"), version)


def validate_changelog_at_ref(ref: str, version: str) -> None:
    result = run(("git", "show", f"{ref}:README.md"), check=False, capture=True)
    if result.returncode != 0:
        raise ReleaseError(f"Cannot read README.md at {ref}: {result.stderr.strip()}")
    validate_changelog_content(result.stdout, version)


def ensure_clean_worktree() -> None:
    status = git("status", "--porcelain", "--untracked-files=normal")
    if status:
        raise ReleaseError(
            "The worktree must be clean before starting or resuming a release:\n" + status
        )


def ensure_remote(remote: str) -> None:
    remotes = set(git("remote").splitlines())
    if remote not in remotes:
        raise ReleaseError(f"Git remote {remote!r} does not exist")


def remote_url(remote: str) -> str:
    return git("remote", "get-url", "--push", remote)


def validate_remote_roles(build_remote: str, publish_remote: str, github_repo: str) -> None:
    build_url = remote_url(build_remote)
    publish_url = remote_url(publish_remote)
    if build_url == publish_url:
        raise ReleaseError("Build and publish remotes resolve to the same push URL")
    normalized_url = publish_url.removesuffix(".git").rstrip("/")
    expected_suffixes = (f"github.com:{github_repo}", f"github.com/{github_repo}")
    if not normalized_url.endswith(expected_suffixes):
        raise ReleaseError(
            f"Publish remote {publish_remote!r} points to {publish_url}, not github.com/{github_repo}"
        )


def fetch_branch(remote: str, branch: str) -> str:
    tracking_ref = f"refs/remotes/{remote}/{branch}"
    run(
        (
            "git",
            "fetch",
            "--prune",
            "--no-tags",
            remote,
            f"+refs/heads/{branch}:{tracking_ref}",
        )
    )
    return git("rev-parse", "--verify", tracking_ref)


def is_ancestor(ancestor: str, descendant: str) -> bool:
    return run(("git", "merge-base", "--is-ancestor", ancestor, descendant), check=False).returncode == 0


def local_tag_commit(tag: str) -> str | None:
    result = run(
        ("git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"),
        check=False,
        capture=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def remote_tag_commit(remote: str, tag: str) -> str | None:
    result = run(
        ("git", "ls-remote", "--tags", remote, f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"),
        check=False,
        capture=True,
    )
    if result.returncode != 0:
        raise ReleaseError(
            f"Could not inspect {tag} on {remote}: {(result.stderr or result.stdout).strip()}"
        )
    direct: str | None = None
    peeled: str | None = None
    for line in result.stdout.splitlines():
        sha, ref = line.split(maxsplit=1)
        if ref.endswith("^{}"):
            peeled = sha
        else:
            direct = sha
    return peeled or direct


def version_at_ref(ref: str) -> str:
    result = run(
        ("git", "show", f"{ref}:backend/server/version.json"),
        check=False,
        capture=True,
    )
    if result.returncode != 0:
        raise ReleaseError(f"Cannot read version.json at {ref}: {result.stderr.strip()}")
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ReleaseError(f"Invalid version.json at {ref}: {exc}") from exc
    value = data.get("version") if isinstance(data, dict) else None
    if not isinstance(value, str):
        raise ReleaseError(f"version.json at {ref} has no string version")
    return normalize_version(value)[0]


def github_release(repo: str, tag: str) -> dict[str, Any] | None:
    result = run(
        ("gh", "api", f"repos/{repo}/releases/tags/{tag}"),
        check=False,
        capture=True,
    )
    if result.returncode == 0:
        try:
            release = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise ReleaseError(f"GitHub returned invalid release data for {tag}") from exc
        if not isinstance(release, dict):
            raise ReleaseError(f"GitHub returned unexpected release data for {tag}")
        return release
    if "HTTP 404" in result.stderr:
        return None
    raise ReleaseError(f"Could not inspect GitHub release {tag}: {result.stderr.strip()}")


def latest_github_release_tag(repo: str) -> str | None:
    result = run(
        ("gh", "api", f"repos/{repo}/releases/latest", "--jq", ".tag_name"),
        check=False,
        capture=True,
    )
    if result.returncode == 0:
        return result.stdout.strip() or None
    if "HTTP 404" in result.stderr:
        return None
    raise ReleaseError(f"Could not inspect the latest GitHub release: {result.stderr.strip()}")


def github_test_runs(repo: str, commit: str) -> list[dict[str, Any]]:
    result = run(
        (
            "gh",
            "run",
            "list",
            "--repo",
            repo,
            "--workflow",
            "Tests",
            "--commit",
            commit,
            "--limit",
            "20",
            "--json",
            "status,conclusion,url,createdAt",
        ),
        capture=True,
    )
    try:
        runs = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ReleaseError("GitHub returned invalid workflow-run data") from exc
    if not isinstance(runs, list) or any(not isinstance(run_data, dict) for run_data in runs):
        raise ReleaseError("GitHub returned unexpected workflow-run data")
    return runs


def wait_for_successful_tests(repo: str, commit: str, timeout: int, poll_interval: int) -> None:
    """Wait for the newest Tests run, including the delay before a run appears."""
    deadline = time.monotonic() + timeout
    last_report = 0.0
    last_state: str | None = None
    while True:
        runs = github_test_runs(repo, commit)
        latest_run = runs[0] if runs else None
        if latest_run is not None and latest_run.get("conclusion") == "success":
            log(f"GitHub Tests passed for {commit[:8]} ({latest_run.get('url')})")
            return

        if latest_run is None:
            state = "no matching Tests run has appeared yet"
        else:
            status = str(latest_run.get("status") or "unknown")
            conclusion = str(latest_run.get("conclusion") or "")
            if status == "completed" and conclusion:
                raise ReleaseError(
                    f"GitHub Tests completed with {conclusion} for {commit[:8]} "
                    f"({latest_run.get('url')})"
                )
            state = f"latest Tests run is {status}"

        now = time.monotonic()
        if now >= deadline:
            raise ReleaseError(f"Timed out after {timeout} seconds waiting for GitHub Tests: {state}")
        if state != last_state or now - last_report >= 60:
            remaining = int(deadline - now)
            log(f"Waiting for GitHub Tests ({remaining}s remaining): {state}")
            last_report = now
            last_state = state
        time.sleep(min(poll_interval, max(1, int(deadline - now))))


def inspect_manifest(reference: str, *, verbose: bool = False) -> dict[str, Any] | None:
    command = ["docker", "manifest", "inspect"]
    if verbose:
        command.append("--verbose")
    command.append(reference)
    result = run(command, check=False, capture=True)
    if result.returncode == 0:
        try:
            value = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise ReleaseError(f"Registry returned invalid manifest JSON for {reference}") from exc
        if not isinstance(value, dict):
            raise ReleaseError(f"Registry returned an unexpected manifest for {reference}")
        return value
    error = (result.stderr or result.stdout).lower()
    if any(message in error for message in ABSENT_MANIFEST_MESSAGES):
        return None
    raise ReleaseError(f"Could not inspect {reference}: {(result.stderr or result.stdout).strip()}")


def existing_image_refs(image: str, version: str) -> list[str]:
    references = [
        f"{image}:{version}",
        f"{image}:{version}-amd64",
        f"{image}:{version}-arm64",
    ]
    return [reference for reference in references if inspect_manifest(reference) is not None]


def validate_images(image: str, version: str) -> list[str]:
    """Return validation problems, or an empty list when all release images agree."""
    multi_ref = f"{image}:{version}"
    amd_ref = f"{image}:{version}-amd64"
    arm_ref = f"{image}:{version}-arm64"
    multi = inspect_manifest(multi_ref)
    amd = inspect_manifest(amd_ref, verbose=True)
    arm = inspect_manifest(arm_ref, verbose=True)

    problems: list[str] = []
    if multi is None:
        problems.append(f"{multi_ref} is absent")
    if amd is None:
        problems.append(f"{amd_ref} is absent")
    if arm is None:
        problems.append(f"{arm_ref} is absent")
    if problems:
        return problems

    assert multi is not None and amd is not None and arm is not None
    descriptors: dict[tuple[str | None, str | None], str | None] = {}
    for descriptor in multi.get("manifests", []):
        platform = descriptor.get("platform", {})
        descriptors[(platform.get("os"), platform.get("architecture"))] = descriptor.get("digest")

    for architecture, manifest in (("amd64", amd), ("arm64", arm)):
        descriptor = manifest.get("Descriptor", {})
        platform = descriptor.get("platform", {})
        if platform.get("os") != "linux" or platform.get("architecture") != architecture:
            problems.append(
                f"{architecture} image reports {platform.get('os')}/{platform.get('architecture')}"
            )
        multi_digest = descriptors.get(("linux", architecture))
        architecture_digest = descriptor.get("digest")
        if not multi_digest:
            problems.append(f"multi-architecture manifest has no linux/{architecture} entry")
        elif architecture_digest != multi_digest:
            problems.append(f"linux/{architecture} digest does not match its architecture tag")
    return problems


def wait_for_images(image: str, version: str, timeout: int, poll_interval: int) -> None:
    deadline = time.monotonic() + timeout
    last_report = 0.0
    while True:
        problems = validate_images(image, version)
        if not problems:
            log(f"Verified {image}:{version} for linux/amd64 and linux/arm64")
            return
        now = time.monotonic()
        if now >= deadline:
            raise ReleaseError(
                f"Timed out after {timeout} seconds waiting for Drone images:\n- "
                + "\n- ".join(problems)
            )
        if now - last_report >= 60 or last_report == 0:
            remaining = int(deadline - now)
            log(f"Waiting for Drone/GHCR ({remaining}s remaining): {'; '.join(problems)}")
            last_report = now
        time.sleep(min(poll_interval, max(1, int(deadline - now))))


def wait_for_github_release(repo: str, tag: str, timeout: int, poll_interval: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        release = github_release(repo, tag)
        if release is not None:
            if release.get("draft"):
                raise ReleaseError(f"GitHub release {tag} was created as a draft")
            return release
        if time.monotonic() >= deadline:
            raise ReleaseError(
                f"Timed out after {timeout} seconds waiting for the GitHub release workflow"
            )
        time.sleep(poll_interval)


def probe_push_access(remote: str, branch: str, commit: str) -> None:
    """Dry-run push so credential problems surface before the release commit exists."""
    result = run(
        (
            "git",
            "push",
            "--dry-run",
            "--no-follow-tags",
            remote,
            f"{commit}:refs/heads/{branch}",
        ),
        check=False,
        capture=True,
    )
    if result.returncode != 0:
        details = "\n".join(value.strip() for value in (result.stdout, result.stderr) if value.strip())
        raise ReleaseError(
            f"Push access to {remote!r} (branch {branch!r}) was refused during the preflight "
            f"dry-run; fix authentication/permissions and rerun:\n{details}"
        )


def push_branch(remote: str, branch: str, expected_commit: str) -> None:
    remote_commit = remote_branch_commit(remote, branch)
    if remote_commit == expected_commit:
        log(f"{remote}/{branch} already points to {expected_commit[:8]}")
        return
    if not is_ancestor(remote_commit, expected_commit):
        raise ReleaseError(f"{remote}/{branch} cannot be fast-forwarded to the release commit")
    # Override push.followTags so even a global Git setting cannot publish extra tags.
    run(
        (
            "git",
            "push",
            "--no-follow-tags",
            remote,
            f"{expected_commit}:refs/heads/{branch}",
        )
    )
    verify_remote_commit = remote_branch_commit(remote, branch)
    if verify_remote_commit != expected_commit:
        raise ReleaseError(f"{remote}/{branch} did not reach the release commit")


def remote_branch_commit(remote: str, branch: str) -> str:
    result = run(
        ("git", "ls-remote", "--heads", remote, f"refs/heads/{branch}"),
        capture=True,
    )
    lines = result.stdout.splitlines()
    if len(lines) != 1:
        raise ReleaseError(f"Could not resolve exactly one {remote}/{branch} branch")
    return lines[0].split(maxsplit=1)[0]


def push_tag(remote: str, tag: str, expected_commit: str) -> None:
    remote_commit = remote_tag_commit(remote, tag)
    if remote_commit is not None:
        if remote_commit != expected_commit:
            raise ReleaseError(
                f"{remote} already has {tag} at {remote_commit[:8]}, expected {expected_commit[:8]}"
            )
        log(f"{remote}/{tag} already points to {expected_commit[:8]}")
        return
    # An explicit refspec is essential: never publish unrelated local tags.
    run(
        (
            "git",
            "push",
            "--no-follow-tags",
            remote,
            f"refs/tags/{tag}:refs/tags/{tag}",
        )
    )
    if remote_tag_commit(remote, tag) != expected_commit:
        raise ReleaseError(f"{remote}/{tag} did not reach the release commit")


def ensure_initial_state(
    *,
    version: str,
    tag: str,
    image: str,
    repo: str,
    build_remote: str,
    publish_remote: str,
) -> None:
    collisions: list[str] = []
    if local_tag_commit(tag):
        collisions.append(f"local tag {tag}")
    if remote_tag_commit(build_remote, tag):
        collisions.append(f"{build_remote} tag {tag}")
    if remote_tag_commit(publish_remote, tag):
        collisions.append(f"{publish_remote} tag {tag}")
    if github_release(repo, tag):
        collisions.append(f"GitHub release {tag}")
    collisions.extend(existing_image_refs(image, version))
    if collisions:
        raise ReleaseError("The new version is already in use:\n- " + "\n- ".join(collisions))


def create_release_commit_and_tag(
    version: str,
    tag: str,
    release_date: str,
    notes: str,
) -> str:
    readme_original = README_PATH.read_text(encoding="utf-8")
    version_original = VERSION_PATH.read_text(encoding="utf-8")
    commit_created = False
    try:
        updated_readme, removed_entries = render_changelog(
            readme_original, version, release_date, notes
        )
        write_version_file(version)
        atomic_write(README_PATH, updated_readme)
        if read_version_file() != version:
            raise ReleaseError("Version file verification failed after writing")
        validate_changelog(version)
        run(("git", "diff", "--check"))
        release_files = sorted(
            (str(README_PATH.relative_to(ROOT)), str(VERSION_PATH.relative_to(ROOT)))
        )
        run(("git", "add", "--", *release_files))
        changed = git("diff", "--cached", "--name-only").splitlines()
        if changed != release_files:
            raise ReleaseError(f"Unexpected staged files: {', '.join(changed) or '(none)'}")
        run(("git", "commit", "-m", f"chore(version): bump to {tag}"))
        commit_created = True
        release_commit = git("rev-parse", "HEAD")
        committed_files = git(
            "diff-tree", "--no-commit-id", "--name-only", "-r", release_commit
        ).splitlines()
        if committed_files != release_files:
            raise ReleaseError(
                f"Release commit contains unexpected files: {', '.join(committed_files) or '(none)'}"
            )
        ensure_clean_worktree()
        run(("git", "tag", "-a", tag, "-m", f"Release {tag}", release_commit))
        if version_at_ref(tag) != version:
            raise ReleaseError(f"{tag} does not contain version {version}")
        validate_changelog_at_ref(tag, version)
    except BaseException:
        # Undo every partial effect so the "fix and rerun" contract holds even
        # when a mid-stage failure (identity, signing, hooks) leaves a mess.
        run(("git", "tag", "-d", tag), check=False, capture=True)
        if commit_created:
            # Hard reset to the release commit's parent restores both index and
            # worktree; the worktree was verified clean before the commit.
            run(("git", "reset", "--quiet", "--hard", "HEAD^"), check=False)
        else:
            atomic_write(README_PATH, readme_original)
            atomic_write(VERSION_PATH, version_original)
            run(("git", "reset", "--quiet"), check=False)
        raise
    for removed_entry in removed_entries:
        log(f"Removed old changelog entry: {removed_entry.split(':', maxsplit=1)[0]}")
    log(f"Created release commit {release_commit[:8]} and annotated tag {tag}")
    return release_commit


def validate_resume_state(version: str, tag: str, release: dict[str, Any] | None) -> str | None:
    validate_changelog(version)
    tag_commit = local_tag_commit(tag)
    if tag_commit is None:
        if release is not None:
            raise ReleaseError(f"GitHub release {tag} exists, but the local tag is missing")
        return None
    if version_at_ref(tag) != version:
        raise ReleaseError(f"Local {tag} does not contain version {version}")
    validate_changelog_at_ref(tag, version)
    head = git("rev-parse", "HEAD")
    if release is None and tag_commit != head:
        raise ReleaseError(
            f"Unpublished {tag} points to {tag_commit[:8]}, while HEAD is {head[:8]}; refusing ambiguity"
        )
    if not is_ancestor(tag_commit, head):
        raise ReleaseError(f"Local {tag} is not an ancestor of HEAD")
    return tag_commit


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create and promote one Ground Station release safely (dry-run by default)."
    )
    parser.add_argument("version", help="release version, such as 0.8.12 or v0.8.12")
    notes_group = parser.add_mutually_exclusive_group()
    notes_group.add_argument(
        "--notes",
        help="curated one-paragraph summary for the README Recent Releases entry",
    )
    notes_group.add_argument(
        "--notes-file",
        help="read the curated README release summary from this file (- reads stdin)",
    )
    parser.add_argument(
        "--release-date",
        help="release date in YYYY-MM-DD format (default: today's local date)",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="perform commits and remote pushes; without this flag only preflight checks run",
    )
    parser.add_argument("--build-remote", default="origin", help="remote that triggers Drone")
    parser.add_argument("--publish-remote", default="github", help="remote that triggers GitHub Release")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument("--github-repo", default=DEFAULT_GITHUB_REPO)
    parser.add_argument(
        "--ci-timeout",
        type=int,
        default=3600,
        help="seconds to wait for GitHub Tests (default: 3600)",
    )
    parser.add_argument(
        "--image-timeout",
        type=int,
        default=21600,
        help="seconds to wait for Drone/GHCR (default: 21600)",
    )
    parser.add_argument(
        "--release-timeout",
        type=int,
        default=900,
        help="seconds to wait for GitHub Actions (default: 900)",
    )
    parser.add_argument("--poll-interval", type=int, default=30)
    parser.add_argument(
        "--skip-ci-check",
        action="store_true",
        help="skip verification that the current commit passed the GitHub Tests workflow",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    try:
        read_notes_from_stdin = args.notes_file == "-"
        notes_file = (
            Path(args.notes_file).expanduser().resolve()
            if args.notes_file and not read_notes_from_stdin
            else None
        )
        require_commands(("git", "python3", "docker", "gh"))
        ensure_git_identity()
        ensure_github_auth()
        version, target_parts = normalize_version(args.version)
        tag = f"v{version}"
        release_date = normalize_release_date(args.release_date)
        if (
            args.ci_timeout <= 0
            or args.image_timeout <= 0
            or args.release_timeout <= 0
            or args.poll_interval <= 0
        ):
            raise ReleaseError("Timeouts and poll interval must be positive")
        if args.build_remote == args.publish_remote:
            raise ReleaseError("Build and publish remotes must be different")
        if not (ROOT / ".git").exists():
            raise ReleaseError(f"{ROOT} is not a Git worktree")
        os.chdir(ROOT)

        ensure_remote(args.build_remote)
        ensure_remote(args.publish_remote)
        validate_remote_roles(args.build_remote, args.publish_remote, args.github_repo)
        ensure_clean_worktree()
        branch = git("branch", "--show-current")
        if branch != args.branch:
            raise ReleaseError(f"Release must run from {args.branch!r}; current branch is {branch!r}")

        current_version = read_version_file()
        _, current_parts = normalize_version(current_version)
        if target_parts < current_parts:
            raise ReleaseError(f"Target {version} is older than current version {current_version}")

        head = git("rev-parse", "HEAD")
        build_head = fetch_branch(args.build_remote, args.branch)
        publish_head = fetch_branch(args.publish_remote, args.branch)
        if not is_ancestor(build_head, head):
            raise ReleaseError(f"Local HEAD does not contain {args.build_remote}/{args.branch}")
        if not is_ancestor(publish_head, head):
            raise ReleaseError(f"Local HEAD does not contain {args.publish_remote}/{args.branch}")

        release = github_release(args.github_repo, tag)
        is_new = target_parts > current_parts
        if is_new:
            if args.notes is None and notes_file is None and not read_notes_from_stdin:
                raise ReleaseError("A new release requires --notes or --notes-file")
            if read_notes_from_stdin:
                release_notes = normalize_release_notes(sys.stdin.read())
            elif notes_file is not None:
                try:
                    release_notes = normalize_release_notes(notes_file.read_text(encoding="utf-8"))
                except OSError as exc:
                    raise ReleaseError(f"Cannot read release notes file {notes_file}: {exc}") from exc
            else:
                release_notes = normalize_release_notes(args.notes)
            if build_head != head or publish_head != head:
                raise ReleaseError(
                    f"For a new release, local HEAD, {args.build_remote}/{args.branch}, and "
                    f"{args.publish_remote}/{args.branch} must be identical"
                )
            latest_tag = latest_github_release_tag(args.github_repo)
            expected_latest = f"v{current_version}"
            if latest_tag != expected_latest:
                raise ReleaseError(
                    f"Latest GitHub release is {latest_tag or '(none)'}, expected {expected_latest}"
                )
            if not args.skip_ci_check:
                wait_for_successful_tests(
                    args.github_repo, head, args.ci_timeout, args.poll_interval
                )
            ensure_initial_state(
                version=version,
                tag=tag,
                image=args.image,
                repo=args.github_repo,
                build_remote=args.build_remote,
                publish_remote=args.publish_remote,
            )
        else:
            release_notes = ""
            log(f"Version file already contains {version}; checking resumable release state")
            resume_commit = validate_resume_state(version, tag, release)

        # Catch credential/permission problems while they are still free to fix.
        probe_commit = head if is_new else (resume_commit or head)
        for remote in (args.build_remote, args.publish_remote):
            probe_push_access(remote, args.branch, probe_commit)

        log(f"Current version: {current_version}; target: {version}; tag: {tag}")
        if not args.execute:
            if is_new:
                readme = README_PATH.read_text(encoding="utf-8")
                _, removed_entries = render_changelog(
                    readme, version, release_date, release_notes
                )
                log(f"README entry: v{version} ({release_date}): {release_notes}")
                for removed_entry in removed_entries:
                    log(f"README will remove: {removed_entry.split(':', maxsplit=1)[0]}")
            log("Dry run passed. No commit, tag, image, release, or remote ref was changed.")
            log("Rerun the same command with --execute to perform the release.")
            return 0

        if is_new:
            release_commit = create_release_commit_and_tag(
                version, tag, release_date, release_notes
            )
        else:
            if resume_commit is None:
                release_commit = git("rev-parse", "HEAD")
                run(("git", "tag", "-a", tag, "-m", f"Release {tag}", release_commit))
                if version_at_ref(tag) != version:
                    raise ReleaseError(f"{tag} does not contain version {version}")
                validate_changelog_at_ref(tag, version)
                log(f"Created missing annotated tag {tag} at {release_commit[:8]}")
            else:
                release_commit = resume_commit

        if release is not None:
            github_commit = remote_tag_commit(args.publish_remote, tag)
            if github_commit != release_commit:
                raise ReleaseError(f"Existing GitHub release {tag} does not match the local tag")
            problems = validate_images(args.image, version)
            if problems:
                raise ReleaseError("Existing release images failed validation:\n- " + "\n- ".join(problems))
            log(f"Release is already complete: {release.get('html_url')}")
            return 0

        push_branch(args.build_remote, args.branch, release_commit)
        push_tag(args.build_remote, tag, release_commit)
        wait_for_images(args.image, version, args.image_timeout, args.poll_interval)

        push_branch(args.publish_remote, args.branch, release_commit)
        push_tag(args.publish_remote, tag, release_commit)
        release = wait_for_github_release(
            args.github_repo, tag, args.release_timeout, args.poll_interval
        )
        if remote_tag_commit(args.publish_remote, tag) != release_commit:
            raise ReleaseError("GitHub tag changed while the release workflow was running")

        log(f"Release complete: {release.get('html_url')}")
        return 0
    except ReleaseError as exc:
        print(f"[release] ERROR: {exc}", file=sys.stderr)
        print(
            "[release] Fix the reported condition and rerun the same version; completed stages are validated and reused.",
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        print(
            "\n[release] Interrupted. Rerun the same version to validate and continue.",
            file=sys.stderr,
        )
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
