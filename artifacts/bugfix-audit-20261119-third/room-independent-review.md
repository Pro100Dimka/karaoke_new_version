# Independent room/social diff review

Reviewed current edits to `frontend/src/features/room/RoomDock.tsx`, `frontend/src/features/social/SocialAlerts.tsx` and their tests. Read-only review was paused at the parent's request to correct a separately identified library regression. No source/test edits and no full suite were performed for this review.

## Conclusion

No concrete new regression confirmed in the reviewed room/social changes. This is a bounded static review, not exhaustive or live verification.

The `RoomDock` change only wraps the existing component with MobX `observer`. The component directly reads `store.online.room` and `useRoomPeople` reads `store.inbox`, so subscription is at the correct consumer. Existing effect dependencies continue to govern artwork fetching, people lookup, and detached-panel lifecycle. The detached-panel drag resumption consumes `heldPointer.current` once; additional observer renders do not replay a drag without a held pointer.

`SocialAlerts` retains one-shot join requests in the outer component, which remains mounted while the inner online-only view disappears on disconnect. It merges requests by account within the current room, keeps an approval available after an error, removes it only after successful approval or explicit dismissal, and filters/clears records when the room changes or is left. An old asynchronous approval dismissal is scoped to room/account and does not remove a request in a different room.

## Contract checks and rejected hypotheses

- Backend `Inbox.view` consumes notices with `take_notices`; treating each later inbox as a replacement would lose unanswered join requests. The queue addresses this contract.
- Electron `SocialChannel` caches `latest` with `notices: []`, so a normal subscription replay does not resurrect an already dismissed one-shot notice.
- `useSocialAction` uses a synchronous ref to block duplicate button actions while the operation is pending, and exposes failure through notifications without dismissing the retained request.
- Losing host status in the same room was examined as a possible authorization mismatch. The current backend `RoomInvites.invite` permits an in-room friend to invite; it does not require the inviter to remain the host. No unsupported host-only requirement was imposed by this review.
- Incoming requests in another room are not retained/rendered for the current room. Leaving to `null` drops the old queue; the new tests exercise returning to the same code after leaving.

## Limits

Room/social tests still replace UI controls in places, and this review did not establish live drag, detachment, reconnect, audio, transport, or two-window behavior. The required Windows `start-multy.bat` two-window gate remains blocked/pending. No live completion claim is supported by this report.
