# Electron spike: Showdown + side panel

A throwaway feasibility test: can Electron show Pokémon Showdown, capture the battle protocol lines, and dock our own panel next to it? Not the product.

## Run

```bash
npm install
npm start
```

Electron 45 downloads its program (~100+ MB) the first time it runs, not during `npm install`. The first `npm start` therefore pauses for a minute with "Downloading Electron binary...". That's normal.

Use two of your own accounts (or a friend) for testing. Don't use this against strangers.

## Useful things to know

- **Spike menu:** Toggle panel (`Ctrl/Cmd+Shift+K`), DevTools for each view, Print storage location, Open battle-logs folder.
- **Battle logs:** `<userData>/battle-logs/<roomid>.log` (the path is printed in the terminal on startup).
- **Panel history:** shows the last 500 lines (CLAUDE.md said 30). Lines over 160 characters, mainly `|request|`, are shortened on screen only; the `.log` file keeps them in full. Scroll up to read older lines; new lines only auto-scroll if you're already at the bottom.
- **Opening DevTools on the Showdown view detaches the capture debugger.** The terminal says so, and capture stays off until you restart.
- Showdown popups and external links open in your normal browser, not inside the app.

## Manual test checklist

| # | Test | Pass if | Result |
|---|---|---|---|
| 1 | `npm start` | Showdown loads, no blank page, panel visible on right | |
| 2 | Resize window small/large, maximize, restore | Both views fill correctly, no overlap or gaps | |
| 3 | Press Ctrl/Cmd+Shift+K twice | Panel hides (Showdown full width), then returns | |
| 4 | Log in with a **username + password** Showdown account, quit app fully, `npm start` again | Still logged in | |
| 5 | (Only if anyone uses it) "Log in with Google" | Note whether Google blocks it. Do NOT try to work around a block | |
| 6 | Challenge a second account / friend to a Gen 9 Random Battle and play a few turns | Panel shows `\|switch\|`, `\|move\|`, `\|-damage\|`, `\|turn\|` lines live | |
| 7 | Finish the battle, open battle-logs folder | A `.log` file exists containing the whole battle incl. `\|win\|` | |
| 8 | Check whether early lines include `\|gen\|` and `\|tier\|` | Note what the first ~15 lines of the log look like | |
