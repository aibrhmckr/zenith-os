# Extraction helper notices

The Windows x64 7za executable supplied by 7zip-bin 5.2.0 identifies itself as
7-Zip 21.07, Copyright (c) 1999-2021 Igor Pavlov. It runs as a separate process.
The package wrapper is MIT; the binary is governed by the upstream 7-Zip terms.

- 7zip-bin-MIT.txt: wrapper license copied from the installed dependency.
- 7zip-21.07.txt: upstream 21.07 source license, including component notices.
- LGPL-2.1.txt: full LGPL text from that upstream release.
- Corresponding upstream source: https://github.com/ip7z/7zip/tree/21.07
- Wrapper and build scripts: https://github.com/develar/7zip-bin

These notices ship with the application. Release maintainers must preserve them
and fulfill applicable source-distribution obligations for the exact helper they
ship; a source link alone is not a substitute for those obligations. Revalidate
the binary version and notices whenever updating 7zip-bin. RPCS3, firmware and
game/license inputs are not part of this bundled helper.
