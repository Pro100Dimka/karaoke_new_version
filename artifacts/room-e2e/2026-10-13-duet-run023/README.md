# Checkpoint 2026-10-13: stopped at user request

Duet is NOT verified or ready. Continue from run020–022 in
`../2026-10-13-capture-upstream/README.md`, then the results below; do not restart the investigation.

## Changes preserved

- Capture-driven processed microphone upstream, independent of render and local monitoring. Dedicated regression failed before the fix and passed afterwards at 48/44.1 kHz. Previous verification: 397 AudioService tests and four other CTest suites passed.
- Late duplicates of already timely accepted packets no longer reset relay recovery. Dedicated regression RED then GREEN; 31 Linux relay tests passed. Recovery window remains 200 packets. Approved relay already deployed: SHA256 `82d6ab80a7a63a5b3826bae728c8c64670fe9349caaa7c0ec5f32244c3d4cca8`.
- Pause before the first scheduled sound no longer freezes a preliminary 10 ms timing estimate. Dedicated regression RED then GREEN; 84 related Python tests passed. Actual singing keeps its fixed deadline. Initial appearance of 10 ms was not reproduced in this live session; retention was reproduced by the regression.
- Explicit Windows device IDs can switch between WASAPI Shared and Exclusive without being falsely rejected by frontend validation. Dedicated regression RED then GREEN; 86 related frontend tests and typecheck passed. Physical switch succeeded on both PCs.

## Production

User approved deployment of startup-candidate/APPROVAL.md. Only `python/backend/room/commands.py` was replaced and the service restarted; readiness passed.
New SHA256: `a5895d0b36fdc025bf6763578f75716e5bb7e9eecef2588f086609ad70b66e00`.
Old SHA256: `90a52c92af3b5f9c19fdfd9319e618b093fb38f32bcf90fc2d9385dcf0f71147`.
Deployment result and rollback copy remain in `startup-candidate/deployment/` locally.
No other new production or network-policy changes were made.

## Physical checks and limits

Both physical PCs were rebuilt/launched through start.bat with the existing Oracle route. Both use Wi-Fi; user cannot connect either via Ethernet.
Exclusive actual periods: PC1 144 frames (3 ms), PC2 240 frames (5 ms). Estimated local monitoring became about 10 ms; this is not an acoustic end-to-end measurement.

Local evidence lives under `../two-pc-singing-gate/`:

| Run | Duration / deadline | Late nonzero packet delta PC1 / PC2 | Decode underrun delta PC1 / PC2 |
| --- | --- | --- | --- |
| run-023-exclusive | 40 s / 52.5 ms | 0 / 12 | 460 / 346 |
| run-024-exclusive-repeat | aborted around 15 s / 55 ms | incomplete | incomplete |
| run-025-exclusive-repeat | 40 s / 65 ms | 97 / 44 | 458 / 45 |

Run024 aborted on RoomServerUnavailable/503; subsequent server readiness was healthy. Run025 had no capture-skipped or confirmed render-clock-skip events on either PC; inserted silence was 735 frames on PC1 and zero on PC2. Different selected deadlines mean these are not a controlled fixed-deadline A/B comparison.

Actual output witnessing in Exclusive failed with WASAPI HRESULT 0x8889000a. Consequently these counters do not prove audible continuity or <=30 ms voice alignment. Full-song acceptance, repeat-launch acceptance, recording-content acceptance with monitoring off, and human duet verification remain outstanding. Some recording files extend beyond the intended short test because the diagnostic script's stop control was hidden; do not treat them as validated full-song runs.

`tcp-route-pc1.json` contains 60 TCP connection samples each: PC1-to-PC2 median 6.01 ms, p95 34.64 ms, max 50.46 ms; PC1-to-Oracle median 33.21 ms, p95 47.1 ms, max 49.2 ms. This supports network variability, not attribution of individual late voice packets or proof of an unavoidable external blocker. The ICMP comparison was aborted and provides no evidence. `late-return.json` used stale frozen traces and must NOT be attributed to run023. QoS was only researched, not implemented or tested.

## Resume state

Diagnostic input and monitoring disabled, peer gains restored to 100%; both application instances closed and their processes checked. Diagnostic SSH tunnel stopped. Last audio configuration remains WASAPI Exclusive (PC1 3 ms, PC2 5 ms). Create a new room through the UI on resume.

Remaining problem: late remote voice delivery and exclusions still prevent verified continuous synchronized singing. Do not claim that smaller buffers, shorter deadlines or individual surviving markers have fixed the duet. Restore trustworthy actual-output capture for the selected device mode before any acceptance claim. No full-song or human test should be declared passed in advance.

Raw recordings, deployment backups and large diagnostic artifacts remain local and ignored by Git. This checkpoint and product changes are committed for transfer; no additional experiment was started after the stop request.
