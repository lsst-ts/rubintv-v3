#!/bin/bash
# Container entrypoint — the v2 start-daemon.sh equivalent. The optional
# sub-apps are built/installed here, at container start rather than at image
# build, so a pod restart picks up new commits of their repos without
# rebuilding this image. Their failures are deliberately non-fatal: the main
# app must come up regardless, and the sub-app mounts skip whatever turns
# out to be missing.

# DDV: clone + flutter-build into a scratch dir (RUBINTV_DDV_PATH points
# inside it). Skipped unless DDV_DEPLOY_BRANCH names the branch to build,
# so sites without DDV don't pay a Flutter build every restart.
if [ -n "$DDV_DEPLOY_BRANCH" ]; then
    DDV_BUILD_DIR=${DDV_BUILD_DIR:-/app/ddv-build}
    script_dir=$(cd "$(dirname "$0")" && pwd)
    rm -rf "$DDV_BUILD_DIR"
    mkdir -p "$DDV_BUILD_DIR"
    (cd "$DDV_BUILD_DIR" && bash "$script_dir/build-ddv.sh") ||
        echo "DDV build failed; continuing without /ddv" >&2
else
    echo "DDV_DEPLOY_BRANCH not set; skipping the DDV build" >&2
fi

# exp_checker: the one knob (RUBINTV_EXP_CHECKER_ENABLED) both installs it
# here and mounts it in the app. The tarball URL avoids cloning;
# setuptools_scm can't derive a version without .git, hence the pretend pin.
case "$RUBINTV_EXP_CHECKER_ENABLED" in
[Tt]rue | 1 | [Yy]es)
    SETUPTOOLS_SCM_PRETEND_VERSION=0.0.0 uv pip install \
        "rubin-exp-checker @ https://github.com/lsst-sitcom/rubin_exp_checker/archive/${EXP_CHECKER_REF:-main}.tar.gz" ||
        echo "exp_checker install failed; continuing without it" >&2
    ;;
esac

# --no-sync: uv run must not "correct" the venv back to the lockfile, which
# would strip the exp_checker install above.
exec uv run --no-sync uvicorn rubintv.main:app --host 0.0.0.0 --port 8000
