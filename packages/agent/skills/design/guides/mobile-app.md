# Mobile app screens

## Frames

- One frame per screen, 390 wide and 844 high. A screen whose content is longer grows by itself: that is how a scrolling screen is shown.
- Flows go in rows with x/y. Sheets, dialogs and menus are frames of their own showing the screen underneath dimmed.

## Structure

- Build the frame of the screen first: the status bar (about 54 px, time and icons), the title area, the tab bar or bottom actions; then the content between them.
- All content in one wrapper with 16 to 20 px side padding, applied once. Space with the wrapper's gap: 24 to 32 px between sections, 12 to 16 px between related items. No spacer elements.
- The first thing on the screen says where the user is and what they can do there.
- Primary actions in the lower half, within reach of the thumb; full-width primary buttons are fine on phones.
- Touch targets at least 44×44; body text at least 16 px; the title the same size on every screen.
- Tab bar: at most 5 items, icon over a short label, the current one clearly marked; it is the last element of the page, not floating over content.
- Follow the platform the brief implies (iOS or Android) for navigation bars, back buttons and switches.

## Content

- One column. Lists over tables; a wide table on a phone becomes a list of cards.
- Cards and rows show the one or two facts that matter; details go one tap deeper.
