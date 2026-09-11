#!/bin/bash
# Container entrypoint — the v2 start-daemon.sh equivalent. The optional
# sub-apps are built/installed here, at container start rather than at image
# build, so a pod restart picks up new commits of their repos without
# rebuilding this image. Their failures are deliberately non-fatal: the main
# app must come up regardless, and the sub-app mounts skip whatever turns
# out to be missing.

# DDV: clone + npm-build into a scratch dir (RUBINTV_DDV_PATH points inside
# it). Skipped unless DDV_DEPLOY_BRANCH names the branch to build, so sites
# without DDV don't pay a build every restart.
if [ -n "$DDV_DEPLOY_BRANCH" ]; then
    DDV_BUILD_DIR=${DDV_BUILD_DIR:-/app/ddv-build}
    script_dir=$(cd "$(dirname "$0")" && pwd)
    rm -rf "$DDV_BUILD_DIR"
    mkdir -p "$DDV_BUILD_DIR"
    # Bound the build: it does a network clone + an npm install (including
    # a git dependency), any of which can *stall* (not just fail) if GitHub
    # or the npm registry blackholes a connection. Unbounded, that hang
    # would keep uvicorn from ever binding
    # 8080 -> the chart's probe fails -> CrashLoopBackOff with no app logs. A
    # timeout turns a stalled build into the same non-fatal "continue without
    # /ddv" path a failed build already takes. Override via DDV_BUILD_TIMEOUT.
    if command -v timeout >/dev/null 2>&1; then
        timeout "${DDV_BUILD_TIMEOUT:-600}" \
            bash -c 'cd "$1" && bash "$2/build-ddv.sh"' _ \
            "$DDV_BUILD_DIR" "$script_dir"
    else
        (cd "$DDV_BUILD_DIR" && bash "$script_dir/build-ddv.sh")
    fi
    ddv_status=$?
    # Non-fatal, but never quiet: the failure is otherwise a couple of lines
    # buried under a few hundred lines of `pub get` output, and the app comes
    # up looking healthy. 124 is timeout(1)'s "deadline hit" status.
    if [ "$ddv_status" -ne 0 ]; then
        if [ "$ddv_status" -eq 124 ]; then
            reason="timed out after ${DDV_BUILD_TIMEOUT:-600}s"
        else
            reason="exited $ddv_status"
        fi
        echo "========================================================" >&2
        echo "DDV BUILD FAILED ($reason) - continuing without /ddv" >&2
        echo "Branch: ${DDV_DEPLOY_BRANCH}. Scroll up for the compiler error." >&2
        echo "========================================================" >&2
    elif [ ! -f "$DDV_BUILD_DIR/ddv/dist/index.html" ]; then
        # Belt and braces: without dist/index.html the mount is skipped
        # anyway, so say why.
        echo "DDV BUILD INCOMPLETE (no dist/index.html) - continuing without /ddv" >&2
    fi
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
# The port is pinned by argument, not $RUBINTV_PORT: a Kubernetes Service
# named rubintv makes the kubelet inject RUBINTV_PORT=tcp://... into every
# pod in the namespace. 8080 is what the phalanx chart's containerPort and
# probe (and V2) expect; RUBINTV_HTTP_PORT — a name Kubernetes never
# injects — is the override knob.
exec uv run --no-sync run_rubintv --port "${RUBINTV_HTTP_PORT:-8080}"
