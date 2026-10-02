# Flow Radio

superfer's radio as a macOS menu bar app. Background focus audio from YouTube, five stations, each resuming where it was left.

- Click the equalizer in the menu bar: the station panel drops down. Pick a station, or `Get in Flow` to play and pause.
- Keys in the panel: arrows move through stations, enter/space plays, esc closes.
- `+ add station` takes a YouTube video, live or playlist link and names it from the title. On a highlighted row, the pencil or `e` renames and the bin or delete removes, both after a confirm.
- Right-click: play/pause, open at login, quit.
- The icon bounces while it plays.

## Run

```
pnpm install
pnpm start          # dev: build the panel and launch
pnpm install-app    # package and copy to /Applications/Flow Radio.app
```

Stations live in `renderer/src/radio.tsx`. Position and station are saved to `~/Library/Application Support/Flow Radio/store.json`.
