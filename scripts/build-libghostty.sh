#!/bin/sh
# Builds libghostty-vt (static + shared) from vendor/ghostty into native/libghostty-vt.
# Needs zig 0.17.x (see mise.toml). vendor/ghostty must be checked out at the pinned commit (see vendor/PINNED_COMMIT).
set -e
cd "$(dirname "$0")/.."
ZIG=${ZIG:-$(mise which zig 2>/dev/null || command -v zig)}
( cd vendor/ghostty && "$ZIG" build -Demit-lib-vt -Doptimize=ReleaseFast --prefix "$OLDPWD/native/libghostty-vt" )
