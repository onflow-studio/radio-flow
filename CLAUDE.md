# Radio Flow

macOS menu bar focus radio: a station panel playing YouTube in a hidden player. Electron (main process in `main/`, React + Tailwind v4 panel in `renderer/`, built with Vite). Repo `radio-flow`, app name "Radio Flow". It started as the radio in email-flow's status line, and its look comes from email-flow's DESIGN.md (tokens copied into `renderer/src/index.css`).

## How it works

- The panel is a frameless window that only hides, so playback survives closing it. `backgroundThrottling: false` keeps the player alive; autoplay policy is relaxed so the tray menu can start playback.
- The page is served from a local HTTP server, not `file://` (YouTube refuses embeds without a real origin). Requests to youtube.com get a `Referer` of a `.test` domain, because some owners refuse embeds from `127.0.0.1` (error 150). Keep both.
- Each station switch builds a fresh player: reusing one leaves the previous playlist loaded when the next one fails to load (YouTube Mixes, `list=RD…`), and that playlist would then be saved as the new station's position.
- A link to a video inside a Mix keeps the video, not the Mix. Errors 100/101/150 mean the station can't play outside youtube.com: the panel says so and offers retry. A station that never starts shows retry after 20 s.
- Stations, the chosen station and positions are saved via IPC to `store.json` in the app's userData folder (`~/Library/Application Support/Radio Flow/`). On first launch after the rename, the old "Flow Radio" folder is copied across.
- The tray icon is drawn in code: the five-bar equalizer in the cyan → periwinkle gradient, still when stopped, bouncing while playing.

## Rules

- The bundle ID stays `dev.f3r.flow-radio` (from the old name); changing it makes macOS treat the app as a new one.
- Renames and removals ask first (in-panel confirm, not a native dialog: a native dialog blurs and hides the panel). Adding a station doesn't.
- The panel never takes focus from the user unexpectedly; esc and outside clicks close it.
- Sentence case, no hype; no personal info in code, docs or images.

## Working

```
pnpm start          # build the panel and launch
pnpm dist           # package release/mac-arm64/Radio Flow.app
pnpm install-app    # package and copy to /Applications
pnpm release        # zip for a GitHub release
```

Release: bump `version` in package.json, `pnpm release`, then `gh release create vX.Y.Z "release/Radio Flow-X.Y.Z-arm64-mac.zip#Radio Flow for macOS (Apple Silicon)"` with notes; GitHub names the asset `Radio.Flow-X.Y.Z-arm64-mac.zip`. Not notarized: the README carries the one-time `xattr -dr com.apple.quarantine` step. Electron's postinstall needs `onlyBuiltDependencies` (pnpm-workspace.yaml). Add files to git by path, never `git add .`.
