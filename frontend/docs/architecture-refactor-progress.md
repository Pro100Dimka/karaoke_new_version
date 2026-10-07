# Architecture refactor: room session boundary (phase 1)

Date: 2026-10-07. This is a progress report, not a claim that the requested architecture refactor is complete.

## BEFORE architecture

```text
RoomModal / FriendsList / SocialAlerts / RoomDock
  -> roomClient + audioClient (+ other concrete clients)
  -> AppContext React room state
RoomSync.tsx -> Room Server + AudioService + Python + Electron + navigation
```

- `RoomSync.tsx` still has over 650 lines and owns polling, transfer, voice reconciliation, navigation, recovery, and hidden state in refs.
- At the start of this phase, features had 62 direct static imports of the four concrete room/audio/Python/desktop clients. `useKaraokeSession.ts` has over 500 lines and also contains application operations.
- Room Server is authoritative for playback state and musical timeline. React state and refs are local projections; treating a server `playing` snapshot as proof that the local project is ready would break late join.
- `AudioService` exposes mutable `session()`, `realtime()`, `media()`, `recording()`, and `network()` engines in its public header. The current production callers do not use these accessors; native tests do. Its `handle()` already routes through bounded handlers for service, mixer, playback, recording, signal, preview, radio, and network commands, so replacing the router mechanically would add little value.

## Root causes

The entry and exit operations were duplicated across UI components and coupled to concrete infrastructure clients. `AppContext` owned an independent room snapshot while `RoomSync` also kept `roomRef`. No automated import rule guarded the frontend dependency direction. These are separate from Room Server authority: the missing owner is for this window's participation and in-flight operations.

## Changes made in this phase

```text
UI intent -> RoomSessionController -> RoomClient / AudioServiceClient ports
                    |
                    +-> local session state -> useSyncExternalStore -> UI
AppProvider -> concrete client composition
```

- Added `RoomSessionController` with a discriminated local state: `disconnected`, `joining`, `joined`, `recovering`, `leaving`, `failed`. Room Server snapshots remain authoritative. The controller owns create/join, voice registration, leave/close, deduplication, cancellation, and compensation of a partial join.
- `AppProvider` now exposes the controller and subscribes to its room snapshot. The room modal, friend invitation flows, room dock exit, and app exit send commands to it. The old `enterRoom` helper was removed.
- Moved the relay mix participant identifier from a feature module to a shared contract, removing an infrastructure-to-feature reverse import.
- Added an architecture checker to `npm test`. It rejects React/UI/concrete infrastructure dependencies from `application` and `domain`, reverse `services -> features` imports, and *new* `features ->` concrete client edges. The 62 existing feature edges are explicitly grandfathered in `architecture-baseline.json`; this is migration debt, not the desired end state.
- Added a repeatable two-window UI check for the changed room entry and exit scenario.

## AFTER architecture and guaranteed invariants

For the migrated operations only: one local controller owns the room join/leave transaction; duplicate joins and leaves coalesce; a cancelled late join cannot publish its room; a failed voice registration compensates by leaving the server room; a failed room close leaves the current room visible; snapshots for a departed room code cannot restore that room. `recovering` is a local connection state. The controller does not modify Room Server playback or audio timing.

The overall target architecture is **not yet reached**: `RoomSync` still orchestrates several services, `roomRef` remains a second local projection during synchronization, the majority of features still import concrete clients, and karaoke and C++ boundaries remain as before.

## Architecture rules

`frontend/scripts/check-architecture.mjs` runs at the start of `npm test`. Its synthetic test confirms rejection of forbidden edges and permits imports in `src/app` as the composition root. The checker currently scans static TypeScript imports and exports; it does not prove runtime ownership, and the temporary baseline still allows the listed feature edges.

## Verification

| Check | Result |
| --- | --- |
| Dedicated controller tests | 9 passed; the initial missing-controller test was confirmed red before implementation |
| React integration and room UI tests | Passed; new assertions were confirmed red before implementation |
| Architecture checker test | Passed; the missing-checker and reverse-edge cases were confirmed red before implementation |
| `npm run typecheck` | Passed |
| `npm test` | Passed: 152 Vitest files / 730 tests, plus 82 Node tests passed and 1 skipped |
| `start-multy.bat` | Built frontend and native service; launched the normal developer and isolated guest profiles |
| Two-window rendered UI | Passed: create/join, guest leave, rejoin, host close, no renderer exceptions; both AudioService diagnostics captured |
| Process cleanup | Both windows closed; no matching Electron, Python backend, or AudioService processes remained |
| `npm run check:rules` | Failed on 9 pre-existing files above the 500-line limit, including `RoomSync`; this phase did not create those oversized files |

Live evidence: `artifacts/room-e2e/2026-10-07T17-46-57-225Z-session/report.md`, screenshots, and machine-readable `report.json`. This live check did not start karaoke or perform a project transfer and therefore does not establish audio synchronization or transfer correctness.

## Remaining risks and requested work

| Requested area | Status |
| --- | --- |
| RoomSync orchestration and complete application owner | Open; move project, voice, polling, readiness, start, and recovery in separately tested slices |
| All feature-to-client dependencies | Open: 62 baseline edges remain; shrink the baseline with each migration |
| Large karaoke hook | Open; map its lifecycle before moving operations |
| AudioService mutable internals | Open; native tests currently depend on the accessors; migrate tests to an appropriate test seam before removal |
| AudioService command routing | Existing handler groups are already present; inspect invariants before any further split |
| Python backend | Unchanged: no concrete architectural defect found in this phase |
| Full room/audio regressions | Open: no two-way microphone, 3–4 participant, 2 ms timeline, project transfer, recording, or device-switch evidence in this phase |

Of the requested lifecycle tests, this phase covers local transitions, duplicate join/leave, join retry, server/audio join failure, reconnecting state, stale response for a *different* room code, and join cancellation on leave. It does not yet cover partial project transfer, renderer reload, participant reconnect, leave/start race, double start, stale response after rejoining the *same* room code, cancellation during transfer, or AudioService restart recovery. No conclusion about those scenarios is drawn from this phase.
