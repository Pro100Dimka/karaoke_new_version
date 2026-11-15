# Lyric line fitting

Date: 2026-11-15

## Behavior

Current and upcoming lyric rows are measured at their normal font size before paint. Rows that exceed the available width shrink to fit; short rows keep their normal size. Current text stops shrinking at 24 px, upcoming text at 18 px. At that limit, wrapping preserves readability. No word timing, grouping or saved project data changes.

The existing layout measurement hook fits rows before measuring glyph geometry for highlighting. Playback position updates only paint the fill. Width changes, new text, selected heading fonts and font loading trigger layout measurements.

## Verification

- Opened the development application through CDP on port 9230 and used rehearsal without recording.
- Before the change, a row in Lumen's song at 1024 by 768 occupied two rows at 73.152 px. After the change, the same text fit one row at 40.7481 px.
- During playback, collected 107 animation frames: each displayed row kept one font size, with size changes only when the displayed text changed.
- Checked viewport widths 640, 1024 and 1920 and changed console docking through the UI. A narrow 225 px text area used the 24 px minimum with wrapping and no horizontal overflow.
- After seeking, the row shown in compact.jpg fit one row at 34.6395 px in 798 px of available width.
- Restored the original viewport and top console placement, returned to the library.
- TypeScript and frontend architecture checks passed. Updated an existing KaraokeStage test to check fitting, no repeated measurements during highlighting, and minimum-size wrapping. No new test functions or test files were added; automated tests were not run.
