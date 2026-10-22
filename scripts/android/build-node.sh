#!/usr/bin/env bash
set -euo pipefail
scripts=$(cd -- "$(dirname -- "$0")" && pwd)
arch=${1:?Usage: build-node.sh arm64|x64}
case "$arch" in
  arm64) helper=/build/helper; export OUT_DIR=/build/helper/out ;;
  x64) helper=/build/helper-x64; export OUT_DIR=/build/x64-build ;;
  *) echo 'Only arm64 and x64 are supported' >&2; exit 2 ;;
esac
export RISUBARD_NODE_JOBS=${RISUBARD_NODE_JOBS:-6}
[[ "$RISUBARD_NODE_JOBS" =~ ^[1-9][0-9]*$ ]]
mkdir -p /build "$OUT_DIR" /export
download() {
  local url=$1 file=$2 hash=$3
  if [[ ! -f "$file" ]]; then
    curl --fail --location --retry 2 "$url" --output "$file.part"
    mv "$file.part" "$file"
  fi
  echo "$hash  $file" | sha256sum --check --status
}
download https://dl.google.com/android/repository/android-ndk-r29-linux.zip /build/ndk.zip \
  4abbbcdc842f3d4879206e9695d52709603e52dd68d3c1fff04b3b5e7a308ecf
if [[ ! -d /build/android-ndk-r29 ]]; then unzip -q /build/ndk.zip -d /build; fi
if [[ ! -d "$helper/.git" ]]; then git clone https://github.com/Delusions6515/node-android-build.git "$helper"; fi
git -C "$helper" checkout 8255800ed90e1c4a1ab5c9d33bf8f1fd46976504
download https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.xz "$OUT_DIR/node-v24.21.0.tar.xz" \
  a6f54defb6fd7c84f41dba13d61e78e9b4e0961712cf61f29715c05f5ced94fc
# The downloaded helper is build tooling only. Ship our small compatibility header with Node source.
cp "$scripts/compat/cpu-features.h" "$helper/patches/24/stubs/cpu-features.h"
sed -E -i 's/-j"(\$\(nproc\)|[0-9]+)"/-j"${RISUBARD_NODE_JOBS}"/g' "$helper/build.sh"
export ANDROID_NDK_HOME=/build/android-ndk-r29 NODE_VERSION=24.21.0 TARGET_ARCH="$arch" NODE_STRIP=1
export LDFLAGS='-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384'
bash "$helper/build.sh"
cp "$OUT_DIR/node-android-$arch-24.21.0.tar.xz" "/export/node-android-$arch-24.21.0-16k.tar.xz"
cp "$OUT_DIR/node-v24.21.0/LICENSE" /export/NODE-LICENSE
