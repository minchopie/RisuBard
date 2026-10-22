#!/usr/bin/env bash
set -euo pipefail
source_dir=${1:?llama.cpp checkout required}
build_dir=${2:?build directory required}
abi=${3:?Android ABI required}
output_dir=${4:?output directory required}
script_dir=$(cd "$(dirname "$0")" && pwd)
revision=ea0c4c2c85fb183ec0fbd30a1af4e4275a18a064
test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
case "$abi" in arm64-v8a|x86_64) ;; *) echo 'Unsupported ABI' >&2; exit 1 ;; esac
test -f "${ANDROID_NDK_HOME:?NDK r29 required}/build/cmake/android.toolchain.cmake"
mkdir -p "$build_dir/source" "$output_dir"
git -C "$source_dir" archive "$revision" | tar -x -C "$build_dir/source"
cp "$script_dir/llama-owner-main.cpp" "$build_dir/source/tools/server/main.cpp"
cmake -S "$build_dir/source" -B "$build_dir/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$abi" -DANDROID_PLATFORM=android-26 -DANDROID_STL=c++_static \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF -DGGML_LLAMAFILE=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_SUBPROCESS=OFF \
  -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_APP=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON \
  '-DCMAKE_EXE_LINKER_FLAGS=-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384'
cmake --build "$build_dir/build" --target llama-server -j 6
cp "$build_dir/build/bin/llama-server" "$output_dir/libllama-server.so"
"$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" "$output_dir/libllama-server.so"
sha256sum "$output_dir/libllama-server.so"
