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
# here and mounts it in the app. Its packaging is unreliable — setup.py
# ships a top-level package literally named "python", so a pip install
# never yields an importable lsst.ts.exp_checker — and its pyproject
# under-declares dependencies (sqlalchemy/psycopg live only in
# requirements.txt). So: install it purely for dependency resolution (both
# lists), and put the clone's python/ tree on PYTHONPATH for the actual
# import. The pretend version spares setuptools_scm the tagless clone.
case "$RUBINTV_EXP_CHECKER_ENABLED" in
[Tt]rue | 1 | [Yy]es)
    EXP_CHECKER_DIR=${EXP_CHECKER_DIR:-/app/exp-checker-src}
    rm -rf "$EXP_CHECKER_DIR"
    # psycopg2 needs pg_config + a compiler to build; the -binary wheel
    # provides the same module without either.
    if git clone --depth 1 --branch "${EXP_CHECKER_REF:-main}" \
        https://github.com/lsst-sitcom/rubin_exp_checker.git "$EXP_CHECKER_DIR" &&
        sed -i 's/^psycopg2$/psycopg2-binary/' "$EXP_CHECKER_DIR/requirements.txt" &&
        SETUPTOOLS_SCM_PRETEND_VERSION=0.0.0 uv pip install \
            "$EXP_CHECKER_DIR" -r "$EXP_CHECKER_DIR/requirements.txt"; then
        export PYTHONPATH="$EXP_CHECKER_DIR/python${PYTHONPATH:+:$PYTHONPATH}"
    else
        echo "exp_checker install failed; continuing without it" >&2
    fi
    ;;
esac

# --no-sync: uv run must not "correct" the venv back to the lockfile, which
# would strip the exp_checker install above. run_rubintv is the console
# entry point from pyproject's [project.scripts] — the same launch path the
# conda/EUPS install uses, so deployment tooling needs no special casing.
exec uv run --no-sync run_rubintv
