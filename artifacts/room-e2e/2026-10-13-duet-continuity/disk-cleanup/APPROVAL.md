# Oracle: stop four abandoned diagnostic captures and free disk

2026-10-13: root filesystem 49 GiB, 100% full. Room GET returns HTTP 500; journal confirms `OSError: [Errno 28] No space left on device`. Service remains active and /health/ready returns ok, so readiness alone misses this failure.

Four tcpdump processes have been writing since October 8. Requested operation: verify their exact command lines, stop these four collectors with SIGINT, wait for exit, then remove ONLY the following obsolete diagnostic files:

| PID | File | Observed bytes |
|---|---|---:|
|285394|/tmp/karaoke-2026-10-08-kernel-arrival.pcap|11344867328|
|285608|/tmp/karaoke-2026-10-08-kernel-arrival-all.pcap|11286409216|
|285872|/tmp/karaoke-2026-10-08-kernel-arrival-final.pcap|11230011392|
|286057|/tmp/karaoke-2026-10-08-kernel-arrival-short.pcap|11174658048|

Approximately 45.0 GB decimal / 41.9 GiB will be freed. The first 2000 complete packets from EACH file have already been copied to this local directory (288024 bytes each). These are samples, not full backups. Removal discards the remainder of these old captures.

No production source, room database, recordings, deployment rollback files, firewall, or router changes. No recursive deletion. Check real room GET and reconnect afterward, not only readiness. If the application still returns errors after disk space is available, a brief restart of karaoke-room-server.service is included; no code deployment is included.

Execution script: cleanup.py, run on Oracle as root only after approval. It verifies all four paths and live process command lines before any stop/delete, refuses symlinks and unexpected paths, and refuses deletion while a capture remains alive. It prints filesystem space and the exact removed files. Script has been syntax-checked locally, not executed on production.
