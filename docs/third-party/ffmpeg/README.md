# FFmpeg source build

FFmpeg and FFprobe remain separate command-line programs. This distribution is built locally from the exact source archives listed in `sources.sha256`; no precompiled FFmpeg or audio-library binaries are used.

The build includes FFmpeg 8.1.2, LAME 3.100, Rubber Band 1.8.1, FFTW 3.3.10, libsamplerate 0.2.2 and zlib 1.3.1. All source archives, the build script, configuration, copyright notices, license texts and binary checksums are retained in the corresponding-source archive. The combined FFmpeg programs are distributed under GPL version 3 or later. The application communicates through ordinary command-line arguments and media files; it does not link these libraries into the proprietary application.

## Normal releases and project backups

The approved kit lives inside this repository in `vendor/ffmpeg`: `bin/ffmpeg.exe`, `bin/ffprobe.exe`, the corresponding-source ZIP, third-party notices and build information. Keep this entire directory in source control and project backups. These are required release inputs, not disposable build output or a shared cache.

`release.bat` reads this kit directly and verifies the binary, source and notice hashes against `distribution.json`. It does not use a system FFmpeg installation, a shared FFmpeg cache or an environment override. Development launches and developer setup use the same local binaries. Copying the complete project folder preserves the kit, even when external FFmpeg caches and installations have been deleted.

Normal application releases reuse these binaries and source materials without compiling FFmpeg or downloading it again. The build instructions below are needed only when changing the FFmpeg distribution. Other development prerequisites such as Node.js, Python and CMake are still required.

## Source archives

Download these original archives into the shared FFmpeg cache on the project's drive, normally `D:/Caches/ffmpeg/downloads`. Verify them against `sources.sha256` before building.

- https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
- https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
- https://github.com/breakfastquay/rubberband/archive/refs/tags/v1.8.1.tar.gz
- https://zlib.net/fossils/zlib-1.3.1.tar.gz
- https://fftw.org/fftw-3.3.10.tar.gz
- https://github.com/libsndfile/libsamplerate/releases/download/0.2.2/libsamplerate-0.2.2.tar.xz

The published source archive also contains these files, so rebuilding does not require the original download hosts to remain available.

## Build

Use an MSYS2 UCRT64 environment on the project's drive with `make`, `diffutils`, `mingw-w64-ucrt-x86_64-gcc`, `mingw-w64-ucrt-x86_64-pkgconf` and `mingw-w64-ucrt-x86_64-nasm`. Exact installed package and compiler versions are recorded in `BUILD-INFO.txt`.

From that environment run:

```sh
scripts/build-ffmpeg.sh D:/Caches/ffmpeg/downloads D:/Build/ffmpeg vendor/ffmpeg
```

The recipe builds static libraries from source, enables the filters and MP3 encoder used by the application, retains FFmpeg's native decoders and uses Windows Schannel for HTTPS. External-library autodetection is disabled. DLL imports are saved in `runtime-dlls.txt`; only Windows system DLLs may be required. GCC/MinGW standard runtime notices and the GCC Runtime Library Exception are included with the distribution. These compiler/system runtimes are distinct from the application audio dependencies whose full sources are included.

From the repository root use the existing Python runtime to prepare the source package and pin the resulting binary, source-archive and notice hashes:

```text
python/.venv/Scripts/python.exe scripts/package-ffmpeg.py D:/Caches/ffmpeg/downloads D:/Build/ffmpeg vendor/ffmpeg
```

`package-ffmpeg.py` packages the actual build inputs and configuration; it does not claim bit-identical output across different compiler versions or machines. No upstream source patches are applied by this recipe. After a change, verify the required media operations before approving the new hashes for release.

## Distribution

`release.bat` stages the locally built tools and license materials, then binds the final installer hash and source archive in `release/ffmpeg-distribution.json`. The publisher uploads the installer, corresponding-source archive and manifest into one draft release and verifies every uploaded hash before publication. The release description and installed application link to the source archive for that exact application version. Source downloads require neither a purchase nor registration.

Retain the matching source assets for every distributed release. The automated integrity checks do not replace review of the licenses or address other application components and codec patent questions. General guidance: https://ffmpeg.org/legal.html and https://www.gnu.org/licenses/gpl-faq.html#MereAggregation.
