#!/usr/bin/env bash
# Applies this project's small changes to the pinned MuseScore submodules.
# Safe to run more than once: already-applied patches are skipped.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

apply() {
    local dir="$1" patch="$2"
    if git -C "$ROOT/$dir" apply --check --reverse "$ROOT/$patch" 2>/dev/null; then
        echo "already applied: $patch"
    else
        git -C "$ROOT/$dir" apply --whitespace=nowarn "$ROOT/$patch"
        echo "applied: $patch"
    fi
}

apply third_party/muse patches/muse_framework.patch
apply third_party/musescore patches/musescore.patch
apply third_party/musescore-4.7 patches/musescore-4.7.patch
