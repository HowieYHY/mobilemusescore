# Source this file to put Emscripten, CMake and Ninja on PATH (Git Bash on Windows).
# Override the locations with EMSDK_DIR / PY_SCRIPTS if yours differ.
EMSDK_DIR="${EMSDK_DIR:-$HOME/tools/emsdk}"
PY_SCRIPTS="${PY_SCRIPTS:-$(python -c "import sysconfig;print(sysconfig.get_path('scripts','nt_user'))" 2>/dev/null)}"

# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
if [ -n "$PY_SCRIPTS" ]; then
    export PATH="$PATH:$(cygpath -u "$PY_SCRIPTS" 2>/dev/null || echo "$PY_SCRIPTS")"
fi
export REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
