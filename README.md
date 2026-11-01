# Showdown Coach

A desktop app (Electron) that wraps [Pokémon Showdown](https://play.pokemonshowdown.com) and adds a chess.com-style **post-game review**: after a battle it flags key moments, labels them (Great / Good / Mistake / Blunder) and explains in plain English what happened. Aimed at beginners.

**Status:** the Electron shell and live battle capture work. Parsing, rules, AI explanation and the review view are still to build. See `docs/plan.md` for the full plan and `NOTES.md` for spike findings.

Use two of your own accounts (or a friend) for testing. Don't use this against strangers.

## Run

```bash
npm install
npm start
```

Electron 45 downloads its program (~100+ MB) the first time it runs, not during `npm install`. The first `npm start` pauses for a minute with "Downloading Electron binary...". That's normal.

```bash
npm test
```

Runs Node's built-in test runner on `test/*.test.js`.

```bash
npm run summarize -- test-data/battle-gen9randombattle-2707357132.log
```

Prints a turn-by-turn summary of a saved battle log (what the parser understood), handy for checking it against what you remember.

## Project layout

```
src/
  main/        main.js (window, views, menu), capture.js (debugger + decodeFrame), logs.js
  core/        pure JavaScript, no Electron: parser.js (lines), state.js (log -> per-turn battle). data/rules come later.
scripts/       summarize.js: print a readable summary of a saved log
  renderer/    panel.html, panel.js, panel-preload.js
test/          *.test.js
test-data/     real battle logs from our own accounts (opponent names anonymised)
docs/          plan.md, spike/
```

## Useful things to know

- **Dev menu:** Toggle panel (`Ctrl/Cmd+Shift+K`), Reload Showdown (`Ctrl/Cmd+R`), DevTools for each view, Print storage location, Open battle-logs folder.
- **Battle logs:** `<userData>/battle-logs/<roomid>.log` (the path is printed in the terminal on startup). On Windows: `C:\Users\<you>\AppData\Roaming\pokemon-helper-electron-spike\battle-logs`.
- **Panel history:** shows the last 500 lines. Lines over 160 characters, mainly `|request|`, are shortened on screen only; the `.log` file keeps them in full.
- **Opening DevTools on the Showdown view detaches the capture debugger.** The terminal says so, and capture stays off until you restart.
- **Reloading Showdown replays the room history.** Every replay starts with `|init|battle`, so the room's log file is rewritten fresh at that point instead of getting duplicate lines. The panel clears at the same moment. The replay carries no old `|request|` lines (which moves you had available each turn), so the ones captured before the reload are put back (`src/core/requests.js`).
- Showdown popups and external links open in your normal browser, not inside the app.

## Manual test checklist

| # | Test | Pass if |
|---|---|---|
| 1 | `npm start` | Showdown loads, no blank page, panel visible on right, window title "Showdown Coach" |
| 2 | Resize window small/large, maximize, restore | Both views fill correctly, no overlap or gaps |
| 3 | Press Ctrl/Cmd+Shift+K twice | Panel hides (Showdown full width), then returns |
| 4 | Log in with a **username + password** Showdown account, quit app fully, `npm start` again | Still logged in |
| 5 | (Only if anyone uses it) "Log in with Google" | Note whether Google blocks it. Do NOT try to work around a block |
| 6 | Challenge a second account / friend to a Gen 9 Random Battle and play a few turns | Panel shows `\|switch\|`, `\|move\|`, `\|-damage\|`, `\|turn\|` lines live |
| 7 | Finish the battle, open battle-logs folder | A `.log` file exists containing the whole battle incl. `\|win\|` |
| 8 | Dev → Reload Showdown (or Ctrl/Cmd+R) | Showdown page reloads |
