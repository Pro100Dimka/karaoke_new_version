#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

sources="$(cygpath -u "${1:?source archive directory is required}")"
work="$(cygpath -u "${2:?build directory is required}")"
output="$(cygpath -u "${3:?output directory is required}")"
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/ucrt64/bin:/usr/bin:$PATH"
export PKG_CONFIG_PATH="$work/prefix/lib/pkgconfig"
export SOURCE_DATE_EPOCH=1795651200
export TEMP="$work/temp" TMP="$work/temp" TMPDIR="$work/temp"
jobs="${FFMPEG_BUILD_JOBS:-8}"
prefix="$work/prefix"
mkdir -p "$work/temp" "$prefix/lib/pkgconfig" "$prefix/include" "$output/bin"

(cd "$sources" && sha256sum -c "$root/docs/third-party/ffmpeg/sources.sha256")
for archive in ffmpeg-8.1.2.tar.xz lame-3.100.tar.gz rubberband-1.8.1.tar.gz fftw-3.3.10.tar.gz libsamplerate-0.2.2.tar.xz zlib-1.3.1.tar.gz; do
    tar -xf "$sources/$archive" -C "$work"
done

export CFLAGS='-O3 -std=gnu11'
export CXXFLAGS='-O3 -std=gnu++11'
export LDFLAGS='-static -Wl,--no-insert-timestamp'

cd "$work/zlib-1.3.1"
make -f win32/Makefile.gcc -j"$jobs" libz.a
cp libz.a "$prefix/lib/"
cp zlib.h zconf.h "$prefix/include/"

cd "$work/lame-3.100"
./configure --prefix="$prefix" --disable-shared --enable-static --disable-frontend --disable-decoder --disable-dependency-tracking
make -j"$jobs"
make install

cd "$work/fftw-3.3.10"
./configure --prefix="$prefix" --disable-shared --enable-static --enable-sse2 --enable-avx --enable-avx2 --with-our-malloc --disable-fortran --disable-dependency-tracking
make -j"$jobs"
make install

cd "$work/libsamplerate-0.2.2"
./configure --prefix="$prefix" --disable-shared --enable-static --disable-examples --disable-dependency-tracking
make -j"$jobs"
make install

cd "$work/rubberband-1.8.1"
mkdir -p lib
make -f Makefile.in -j"$jobs" static CXX=g++ \
    CXXFLAGS="-O3 -std=gnu++11 -DNDEBUG -DNO_THREAD_CHECKS -DNO_TIMING -DHAVE_LIBSAMPLERATE -DHAVE_FFTW3 -DFFTW_DOUBLE_ONLY -I$prefix/include -I. -Isrc"
cp lib/librubberband.a "$prefix/lib/"
cp -r rubberband "$prefix/include/"
cat > "$prefix/lib/pkgconfig/rubberband.pc" <<EOF
prefix=$prefix
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: rubberband
Description: Rubber Band Library
Version: 1.8.1
Libs: -L\${libdir} -lrubberband
Libs.private: -lsamplerate -lfftw3 -lstdc++ -lm
Cflags: -I\${includedir}
EOF

cd "$work/ffmpeg-8.1.2"
./configure --prefix="$output" --extra-version=advoice1 \
    --disable-autodetect --disable-shared --enable-static --enable-gpl --enable-version3 \
    --enable-libmp3lame --enable-librubberband --enable-zlib --enable-schannel \
    --disable-ffplay --disable-doc --disable-debug --pkg-config-flags=--static \
    --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib -static -Wl,--no-insert-timestamp"
make -j"$jobs" ffmpeg.exe ffprobe.exe
cp ffmpeg.exe ffprobe.exe "$output/bin/"
{
    "$output/bin/ffmpeg.exe" -version
    gcc --version
    g++ --version
    nasm --version
    make --version
    pacman -Q
} > "$output/BUILD-INFO.txt" 2>&1
objdump -p "$output/bin/ffmpeg.exe" | grep 'DLL Name:' > "$output/runtime-dlls.txt"
objdump -p "$output/bin/ffprobe.exe" | grep 'DLL Name:' >> "$output/runtime-dlls.txt"
sha256sum "$output/bin/ffmpeg.exe" "$output/bin/ffprobe.exe"
