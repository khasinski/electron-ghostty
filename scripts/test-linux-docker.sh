set -e
mkdir -p /w && cd /w
tar -C /src --exclude=node_modules --exclude=build --exclude=vendor --exclude=native/libghostty-vt --exclude=bench -cf - . | tar xf -
mkdir -p native && cp -r /src/native/linux-arm64 native/libghostty-vt
apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libdrm2 libxkbcommon0 libatk-bridge2.0-0 libcups2 build-essential python3 >/dev/null
npm install --no-audit --no-fund --ignore-scripts electron@45 node-addon-api node-gyp @electron/rebuild >/dev/null 2>&1
node node_modules/electron/install.js
npx electron-rebuild -f -w ghostty_native 2>&1 | tail -3 || true
ls build/Release/*.node
export HOME=/root SHELL=/bin/bash
printf "PS1='%% '\n" > /root/.bashrc
GHOSTTY_SCRIPT=/w/test/app-input.js xvfb-run -a node_modules/.bin/electron --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist . 2>&1 | tail -15
