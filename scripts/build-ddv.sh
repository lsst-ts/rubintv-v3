#!/bin/bash
# Build the DDV web app (rubintv-ddv) for serving at {path_prefix}/ddv.
#
# Runs at container start from scripts/start.sh, but works anywhere with git
# and node on the PATH. Clones into the current directory; the build lands in
# ./ddv/dist.
#
# The app's charting library, rubin-charts, is not cloned here: it is a git
# dependency in the app's package.json, pinned to a commit in its lockfile,
# so `npm ci` fetches and builds it.
#
# Environment:
#   DDV_REPO               repository to clone
#                          (default: https://github.com/ugyballoons/rubintv-ddv)
#   DDV_DEPLOY_BRANCH      branch of that repository to build (default: main)
#   DDV_BASE_HREF          URL path the build is served under; must be
#                          bookended by "/" (default: /rubintv/ddv/)
#   DDV_CLIENT_WS_ADDRESS  websocket path baked into the client, relative to
#                          the page's host; the app appends /client
#                          (default: rubintv/ws/ddv)
set -ex

DDV_REPO=${DDV_REPO:-https://github.com/ugyballoons/rubintv-ddv}
DDV_DEPLOY_BRANCH=${DDV_DEPLOY_BRANCH:-main}
DDV_BASE_HREF=${DDV_BASE_HREF:-/rubintv/ddv/}
DDV_CLIENT_WS_ADDRESS=${DDV_CLIENT_WS_ADDRESS:-rubintv/ws/ddv}

git clone --single-branch --depth 1 --branch "$DDV_DEPLOY_BRANCH" "$DDV_REPO" ./ddv

cd ddv
# A clone carries no .env, so the build takes its configuration from the
# environment alone (Vite lets real environment variables win regardless).
npm ci --no-audit --no-fund
VITE_BASE="$DDV_BASE_HREF" VITE_DDV_WS_PATH="$DDV_CLIENT_WS_ADDRESS" npm run build
