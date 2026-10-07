#!/usr/bin/env bash
# Publishes app/dist (from `npm run build` in app/) to the gh-pages branch,
# which GitHub Pages serves at https://<owner>.github.io/<repo>/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="$ROOT/build/ghpages"

[ -f "$ROOT/app/dist/index.html" ] || { echo "app/dist missing: run 'npm run build' in app/ first"; exit 1; }

git -C "$ROOT" worktree prune
if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
    git -C "$ROOT" fetch origin gh-pages
    git -C "$ROOT" worktree add "$WT" gh-pages
fi

# replace everything except git metadata with the new build
find "$WT" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$ROOT/app/dist/." "$WT/"
touch "$WT/.nojekyll"
printf '*.wasm -text\n*.sf3 -text\n*.mjs -text\n' > "$WT/.gitattributes"

cd "$WT"
git add -A
if git diff --cached --quiet; then
    echo "nothing changed"
    exit 0
fi
git -c core.safecrlf=false commit -q -m "Publish web app build $(git -C "$ROOT" rev-parse --short HEAD)"
git push origin gh-pages
echo "published: $(git rev-parse --short HEAD)"
