# Third audit: visible room and social workflows

## Status and ownership

- Worktree: `/workspace/scratch/726a7fe1e251/karaoke_new_version`
- Branch: `fix/app-bugs-excluding-processing-20261119`
- Starting HEAD: `9d44f17dfa7fbc321c5dc8e8c8a722e9e511cfaf`
- Agent: `/root/visible_rooms_social_audit`
- Source frozen after the final focused verification on 2026-11-19 at approximately 19:22 UTC. No further source edits are planned by this agent.
- Two concrete user-facing defects were reproduced with failing tests before their corresponding product edits.
- Full frontend verification, real rendered inspection, artifact publication, commit, and push belong to the root agent. This agent ran no full suite and made no commit, push, or PR.

## 1. The room dock stopped following room and friend updates

### User-visible failure

After joining a room, ordinary snapshots for that same room did not reliably refresh the dock. Newly joined participants were absent; the displayed host controls, selected song, transfer progress, connection status, and playlist could remain stale. A pushed friendship update also left a participant's relationship unchanged until an unrelated component render occurred.

### Traced cause

`subscribeApplication` writes every session snapshot to `store.online.room`, an observable reference. `RoomDock` read that store and, through `useRoomPeople`, `store.inbox`, but was a plain React component. The two application hooks used by the dock subscribe to `RoomSessionScope`, which remains the same object during ordinary snapshots. `AppShell` does not read room state itself. Consequently these changes did not subscribe the dock to a React rerender.

### Change

Wrap `RoomDock` in MobX `observer`. This is the only change in its product file: one import and the component wrapper. No room service, transport, audio, clock, or mixing behavior was changed.

### Regression evidence

`RoomDock.test.tsx` exercises the real component, real observable store, and real `useRoomPeople`. Presentation cards, detached-window layout, and external application ports are boundary stubs.

- Actual RED: 2 tests failed, exit 1. The new participant was missing from the DOM, and the relationship remained `None` after the pushed inbox became `Friend`.
- Initial GREEN: 2 tests passed, exit 0.
- Assertions also cover replacement of the host role, reconnect text, selected song/progress, and playlist title/count without manually rerendering the component.

## 2. A request to join disappeared before the host could answer

### User-visible failure

A friend's request to join appeared as an actionable alert but disappeared on the next unrelated inbox push. A temporary social disconnect also discarded it. Conversely, successfully approving a request did not remove the original alert, allowing the same action again until another push. There was no action to dismiss a request without inviting that person.

### Traced cause

The backend path is `RoomInvites.request_join` → `EventStore.add_notice` → `Inbox.view` → `take_notices`. These are one-shot notices, not persistent pending invitations. `SocialAlerts` derived actionable room requests directly from the current `inbox.notices`. The online-only child also unmounts while the social inbox is offline. The approval action did not remove a handled request locally.

### Change

The always-mounted `SocialAlerts` wrapper retains pending requests for the current room across later inbox pushes and a temporary social disconnect. Requests are deduplicated by account within that room. Successful approval removes its request; a failed approval leaves the action available for retry. A local Close button dismisses a request without sending an invitation. Leaving the room removes retained requests for that room. Existing invitation coordination is unchanged.

The buffer intentionally lives in the running renderer. This change does not introduce durable storage of one-shot notices across renderer restarts and does not change the backend protocol.

### Regression evidence

- Actual RED: 4 tests failed and 7 passed, exit 1. Failures were loss on a normal inbox push, loss across offline/reconnect, alert remaining after successful retry, and the missing dismiss action.
- GREEN after product edits: both affected component test files passed, 13 tests total, exit 0.
- A boundary test confirms that leaving and rejoining the same room does not restore a retained request after it was removed and the server inbox no longer carries the notice.

## Final focused verification

Command, from `frontend/`:

```sh
node node_modules/vitest/vitest.mjs run src/features/room/RoomDock.test.tsx src/features/social/SocialAlerts.test.tsx src/application/social/RoomInvitationCoordinator.test.ts src/features/social/useSocialAction.test.tsx
```

Result: **4 files passed, 22 tests passed, exit 0** after the final source edit. Scoped `git diff --check` also exited 0.

Raw logs, all under `/workspace/scratch/726a7fe1e251`:

| Log | Outcome |
| --- | --- |
| `third-rooms-dock-red.log` | Exit 1; 2 failed |
| `third-rooms-dock-green.log` | Exit 0; 2 passed |
| `third-rooms-join-requests-red.log` | Exit 1; 4 failed, 7 passed |
| `third-rooms-visible-green.log` | Exit 0; 13 passed in 2 files |
| `third-rooms-focused-green.log` | Exit 0; 22 passed in 4 files; final source |

## Scope reviewed and practical limits

| Workflow | Coverage in this pass |
| --- | --- |
| Room dock membership, host role, song/transfer/connection/playlist display | End-to-end source trace from application store update; component RED/GREEN |
| Room participant friendship updates | Real `useRoomPeople` + observable store component RED/GREEN |
| Friend requests to join, host approval/failure/retry/dismissal | Backend notice lifecycle traced read-only; component RED/GREEN including temporary social disconnect |
| Create/join/leave modal and session ownership | Read-only trace of `RoomModal`, `RoomSessionController`, `roomClient`; duplicate joins already coalesced by controller, no speculative change |
| Invitations and create-together | Read-only coordinator/UI trace; existing coordinator regression suite included in final focused run |
| Friends list, request dialog, history, profile/photo | Read-only inspection of components, client contracts, avatar/profile use, and relevant backend social paths; not comprehensively exercised |
| Clipboard failures, detached window interaction, host transfer/removal dialogs | Read-only inspection; not live-verified or changed in this pass |

These focused tests are intermediate verification, not evidence that every room/social defect has been found.

### Mandatory live room gate remains blocked

This Linux workspace cannot run the required real Windows `start-multy.bat` workflow with two actual Electron windows and native audio services. This agent did not run a substitute and did not verify real multi-window room interaction, live audio continuity, transfer readiness, or device behavior. Root must retain this explicit gap in the combined report. Room work must not be described as fully live-verified based on these tests.

## Changed files and frozen SHA-256

| File | SHA-256 |
| --- | --- |
| `frontend/src/features/room/RoomDock.tsx` | `331bbf33e5f24d98f8f0ebd9d0148ec64e9f851210cea1da97a88958d85a7313` |
| `frontend/src/features/room/RoomDock.test.tsx` | `bcfe7da59e529e542d5b42c45b25af5cc19570ddddc474d6d49a2811cde648b3` |
| `frontend/src/features/social/SocialAlerts.tsx` | `a9c9ebceafb5103637ee630438ab8b53207830200d2ae19ecd0f94e854e2d1a8` |
| `frontend/src/features/social/SocialAlerts.test.tsx` | `94892d56fa3d14ebd8d5ff241f652f5ac4f4dc542ad325660eac4b02b6828987` |

No backend file was edited. No processing, AI/ASR/separation/alignment/pitch/DSP, AD Master/studio/analysis, recording algorithm, room audio clock, or mixing implementation/test/config file was edited by this agent.
