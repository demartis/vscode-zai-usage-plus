#!/usr/bin/env bash
#
# Release script for vscode-zai-usage-plus.
#
# Builds the extension, publishes the version from package.json to the VS Code
# Marketplace, tags the release (v<version>), pushes main + the tag, and
# creates the GitHub release when the GitHub CLI is available.
#
# Usage:
#   ./release.sh
#
# Requirements:
#   - Run from the main branch with a clean working tree.
#   - Marketplace credentials: either the VSCE_PAT environment variable set,
#     or a saved Personal Access Token from `npx @vscode/vsce login demartis`.

set -euo pipefail

cd "$(dirname "$0")"

# --- Preconditions -----------------------------------------------------------

branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" != "main" ]]; then
  echo "✗ Must run on main (currently on '$branch')." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree is not clean — commit or stash first:" >&2
  git status --short >&2
  exit 1
fi

version=$(node -p "require('./package.json').version")
tag="v$version"

if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "✗ Tag $tag already exists — bump the version in package.json first." >&2
  exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  echo "✗ Tag $tag already exists on origin — bump the version in package.json first." >&2
  exit 1
fi

echo "▸ Releasing $tag"

# --- Build & verify ----------------------------------------------------------

if [[ ! -d node_modules ]]; then
  echo "▸ Installing dependencies"
  npm ci 2>/dev/null || npm install
fi

echo "▸ Lint & format check"
npm run check

echo "▸ Compile"
npm run compile

echo "▸ Package VSIX"
npx --yes @vscode/vsce package --no-git-tag-version

# --- Publish to the VS Code Marketplace ---------------------------------------

echo "▸ Publishing to the VS Code Marketplace"
if [[ -n "${VSCE_PAT:-}" ]]; then
  npx --yes @vscode/vsce publish -p "$VSCE_PAT"
else
  # Uses the PAT saved by `npx @vscode/vsce login demartis`, if present.
  npx --yes @vscode/vsce publish
fi

# --- Tag & push ---------------------------------------------------------------

echo "▸ Tagging $tag and pushing"
git tag "$tag"
git push origin main "$tag"

# --- GitHub release (optional) -------------------------------------------------

release_url="https://github.com/demartis/vscode-zai-usage-plus/releases/new?tag=$tag&title=Release%20$tag"

if command -v gh >/dev/null 2>&1; then
  echo "▸ Creating GitHub release"
  notes=$(awk "/## \\[$version\\]/,/## \\[/" CHANGELOG.md | sed '1d' | sed '/^## \[/,$d' | sed '/^$/d' || true)
  gh release create "$tag" --title "Release $tag" --notes "${notes:-Release $tag}" && exit 0
  echo "✗ gh release failed — create it manually:" >&2
fi

echo
echo "✓ Published $version to the marketplace."
echo "  Finish the release by creating the GitHub release:"
echo "  $release_url"
