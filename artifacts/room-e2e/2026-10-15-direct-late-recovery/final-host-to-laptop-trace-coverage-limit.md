# Host to laptop: trace coverage boundary

Tested native commit: `5beb7ed1e40b1960d51d5b30ec52c5de1c937983`. Selected deadline: **57.5 ms**. Read-only analysis; no product, analyzer, or gate changes.

Receiver WAV origin from backing alignment: song **4.378667095 s**. The reported UNKNOWN times are song coordinates, not WAV seconds. Each WAV coordinate below is mapped through the saved valid receiver timeline CSV to its actual presentation position.

| Reported UNKNOWN song s | Receiver WAV s | Actual presentation song span s | Expected source span s | Retained packets |
| --- | --- | --- | --- | --- |
| 38.03867 | 33.660003 | 38.042003–38.102024 | 37.984503–38.044524 | None |
| 38.91867 | 34.540003 | 38.922315–39.002170 | 38.864815–38.944670 | None |
| 39.17867 | 34.800003 | 39.182836–39.262815 | 39.125336–39.205315 | None |

The receiver trace has **768 unique packets in eight separate 96-packet windows**, approximately 240 ms each. It is not continuous through its last retained song time.

| Sequences | Source song span s | Target presentation song span s |
| --- | --- | --- |
| 67543–67638 | 0.087125–0.327125 | 0.144625–0.384625 |
| 70978–71073 | 8.674625–8.914625 | 8.732125–8.972125 |
| 73199–73294 | 14.227125–14.467125 | 14.284625–14.524625 |
| 75421–75516 | 19.782125–20.022125 | 19.839625–20.079625 |
| 77662–77757 | 25.384625–25.624625 | 25.442125–25.682125 |
| 79888–79983 | 30.949625–31.189625 | 31.007125–31.247125 |
| 82119–82214 | 36.527125–36.767125 | 36.584625–36.824625 |
| 83797–83892 | 40.722125–40.962125 | 40.779625–41.019625 |

Mandatory failed 1-second cells at song **32.000**, **39.000**, and **73.6079375** also have no overlapping retained packet trace. The final trace window contains QUEUE_LATE decisions at target song 40.78–41.02 s; they cannot establish the cause of earlier cells.

**Causal attribution: undetermined. Physical gate: FAIL.** The recorded data cannot connect those exact cells to sequence/socket arrival/late decision/queue cursor. Low NCC establishes unidentified voice, not zero PCM or a proven audible dropout. Aggregate counters cannot supply the missing packet-level attribution; neither PLC nor retiming is established as the cause.

Exact mappings and source paths: [JSON](final-host-to-laptop-trace-coverage-limit.json).
