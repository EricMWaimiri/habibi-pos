# Proposed clean-repository publication ? NOT EXECUTED

Owner must approve the exact export manifest hash and repository creation first. No git init/staging/commit/API creation/push is authorized by preparing this file. Existing repositories, remotes, branches and histories remain unchanged.

Target: **EricMWaimiri/habibi-pos**, private, default branch **main**, one new root commit. The authenticated account was verified by read-only /user API; target returned404. Recheck immediately before creation. Do not use or push the old feature branch. Do not copy .git or clone the old repository.

The commands below assume the shell is opened in the clean export. Its sibling review directory holds the exact NUL path list and guarded API creation helper. It is not part of the repository. Substitute the separately reviewed manifest hash literally; stop on any mismatch.

```powershell
$release=(Get-Location).Path
$review=Join-Path (Split-Path $release -Parent) 'habibi-pos-clean-review'
# Recheck all files against RELEASE-MANIFEST.json and SECURITY-REVIEW.json first.
git init --initial-branch=main
git config --local core.autocrlf false
git config --local core.safecrlf true
# Use the existing verified Git author identity; do not invent an identity.
git add --pathspec-from-file="$review\approved-paths.nul" --pathspec-file-nul
git diff --cached --stat
git diff --cached --check
# Inspect exact staged paths, modes and SHA256 blob bytes versus the reviewed manifest.
# No generated files, secrets, submodules or unexpected binaries may be staged.
git commit -m "Initial release: consolidated Habibi Lounge POS"
# The helper rechecks one-root-commit inventory/blob hashes and verified GitHub identity.
python "$review\create-private-repository.py" --release "$release" --manifest-sha256 REVIEWED_MANIFEST_SHA256 --approved
git remote add origin https://github.com/EricMWaimiri/habibi-pos.git
git push -u origin refs/heads/main:refs/heads/main
git ls-remote origin refs/heads/main
git rev-parse HEAD
git rev-list --count HEAD
```

No force push. Stop if repository exists, identity differs, history is not one root commit, branch is not main, inventory/hash/secret check fails or remote differs. Repository creation and push are separate operations; preserve local state and report any error, never delete/recreate the target automatically. Confirm remote visibility and default branch through the authenticated GitHub API; confirm remote HEAD matches local and all files/migration/overlay blobs match. Do not modify old remotes or merge old history.

After separately approved publication, clone ONLY the new repository into a new verification directory. Verify manifest, private visibility, one-root history, npm.cmd ci, local Client generation/validation, release verifier, focused tests and documented disposable-database install/start procedure. Do not clone the previous repository or use protected TEST data. Report any missing dependency before promoting the new repository to authority. Active-workspace migration is separate authorization.
