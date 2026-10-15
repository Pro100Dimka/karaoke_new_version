# A&D Voice 1.1.10 release verification

Built from merged main commit `d10df920491a4b93d796cc583c172a5dae801974`.
The final evidence commit changes only artifacts; application payload inputs
remain identical to that build.

- Public `release.bat`: PASS. Default `.env.example` selected; no private-env build.
- Bundled offline runtime imports, CPU DSP, WAV and media tools: PASS.
- Inno Setup completed successfully; installer **1,106,554,318 bytes**.
- Installer SHA-256: `6608FB387779A4D78562643BE831AFEB3DA84ADB08D88C5501B8419A79A8DFB8`.
- Application executable version and installer ProductVersion: **1.1.10**.
- No signing certificate is configured; installer is **NotSigned**.
- Real packaged UI: library, Audio, Appearance and Advanced tabs opened successfully
  in an isolated smoke profile. Bundled Python and AudioService process paths verified.
- Smoke application closed through rendered UI; owned process count afterwards: **0**.
- Laptop repository was clean, fast-forwarded onto main at the same source commit,
  and its frontend, AudioService and NativeVoiceRelay Release build passed.

Machine-readable proofs: [installer](INSTALLER.json), [UI](PACKAGED_UI.json),
[process paths](PACKAGED_PROCESSES.json), [cleanup](PACKAGED_CLEANUP.json),
[laptop source/build synchronization](LAPTOP_SYNC.json).
Full release build output is preserved as `release-build.txt.gz`.

The physical room gate remains **FAIL**, as disclosed in [release notes](RELEASE_NOTES.md).
The release build and packaged UI smoke do not replace that physical acceptance result.

Publication is performed after this verification, using an explicit `v1.1.10`
tag on the final main commit. GitHub asset size and SHA-256 are checked against
the installer values above before reporting successful publication.
