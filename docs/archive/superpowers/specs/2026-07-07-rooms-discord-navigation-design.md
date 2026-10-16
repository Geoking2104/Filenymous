# Rooms Discord-Style Navigation Design

## Decision

Use the Discord Shell direction for Filenymous Rooms, with one simplification: the room list appears only when several rooms are active. For the common case of one temporary room, users see a focused workspace instead of an empty navigation column.

## UX Structure

- A compact room header gives the room name, live status, and primary actions: create, copy invite, close.
- The center of the screen is the room activity: chat, file drop, and file transfer state.
- The right side keeps participants, invite link, and room status visible.
- The right side also lets the user choose a simple avatar pictogram so participants are easier to distinguish.
- A clear "12 users maximum" warning is always visible in Rooms.
- The room list column is conditional. It remains hidden with zero or one active room, then appears when the local room directory has more than one entry.
- Technical networking details stay out of the main room surface.

## Implementation Notes

- Preserve existing IDs and functions used by tests and transfer logic: `public-room-link`, `public-room-status`, `public-room-peers`, `public-room-file-input`, `public-room-files`, `public-room-chat-input`, `public-room-chat-log`.
- Add a small local room directory model so the UI can show a room list later without changing the transfer protocol.
- Keep avatar selection local and lightweight through `PUBLIC_ROOM_AVATARS` and `setPublicRoomAvatar()`.
- Keep the existing one-room transfer behavior intact.
- Sync `docs/demo/index.html` to `filenymous-app.html` after implementation.

## Validation

- Static tests must confirm the new shell and conditional room list tokens are present in both HTML outputs.
- Browser smoke must verify create room, invite link generation, two-peer room join, chat, and file-ready state still work.
