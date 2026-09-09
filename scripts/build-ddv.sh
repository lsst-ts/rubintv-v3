#!/bin/bash
# Build the DDV Flutter app (rubintv_visualization) and its rubin_chart
# dependency, for serving at {path_prefix}/ddv.
#
# Runs in the Dockerfile's ddv stage, but works anywhere with flutter (and
# ideally fvm) on the PATH. Clones into the current directory; the build
# lands in ./ddv/build/web.
#
# Environment:
#   DDV_DEPLOY_BRANCH      branch of both repos to clone (default: main)
#   DDV_BASE_HREF          base href baked into the build; must be bookended
#                          by "/" (default: /rubintv/ddv/)
#   DDV_CLIENT_WS_ADDRESS  websocket address baked into the client; the app
#                          appends /client (default: rubintv/ws/ddv)
set -ex

DDV_DEPLOY_BRANCH=${DDV_DEPLOY_BRANCH:-main}
DDV_BASE_HREF=${DDV_BASE_HREF:-/rubintv/ddv/}
DDV_CLIENT_WS_ADDRESS=${DDV_CLIENT_WS_ADDRESS:-rubintv/ws/ddv}

# rubin_chart must sit alongside ddv/ (a path dependency in its pubspec).
git clone --single-branch --branch "$DDV_DEPLOY_BRANCH" https://github.com/lsst-sitcom/rubin_chart
git clone --single-branch --branch "$DDV_DEPLOY_BRANCH" https://github.com/lsst-ts/rubintv_visualization ./ddv

# Each repo may pin its Flutter SDK via fvm; fall back to global flutter.
cd rubin_chart
if [ -f ".fvmrc" ] || [ -f "fvm_config.json" ]; then
    fvm install
    fvm use
fi
cd ..

cd ddv
echo "ADDRESS=$DDV_CLIENT_WS_ADDRESS" > .env
if [ -f ".fvmrc" ] || [ -f "fvm_config.json" ]; then
    fvm install
    fvm use
    fvm flutter build web --base-href "$DDV_BASE_HREF" --profile --source-maps
else
    flutter build web --base-href "$DDV_BASE_HREF" --profile --source-maps
fi
