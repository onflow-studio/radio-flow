import { Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Background audio from YouTube, the station panel from superfer's radio hanging from the menu bar. The
 * window only hides, never closes, so playback survives the panel going away. Nothing loads from YouTube
 * until the first play. Each station resumes where it was left, across restarts; live streams have nothing
 * to resume. Stations can be added from a YouTube link, renamed and removed; renames and removals ask first.
 */
type Station = { id: string; label: string; live?: boolean } & ({ video: string } | { playlist: string });

const DEFAULT_STATIONS: Station[] = [
  { id: "hacker", label: "hacker radio", video: "sjSnCKudqj0", live: true },
  { id: "gamma", label: "40hz gamma", video: "tAIiXRZNh9E" },
  { id: "techno", label: "minimal techno", video: "ujrBG09lcYY" },
  { id: "deep-work", label: "deep work mix", video: "UDTmUzu05BE" },
  { id: "brainfm", label: "brain.fm sessions", playlist: "PLm1EodmV4HIjT0EjDGKFsWU5vOidU2rtW" },
];

const API_SRC = "https://www.youtube.com/iframe_api";
const API_TIMEOUT_MS = 15_000;
// YouTube refuses to play in players smaller than 200px.
const PLAYER_SIZE = 200;
const STORAGE_KEY = "radio-station";
const STATIONS_KEY = "radio-stations";
// Longest name kept from a YouTube title; the row truncates past its width anyway.
const LABEL_MAX = 40;
const POSITIONS_KEY = "radio-positions";
const SAVE_INTERVAL_MS = 5_000;
// A station that has not started playing by then shows retry instead of a silent, glowing dot.
const STALL_MS = 20_000;

export type Status = "idle" | "loading" | "playing" | "paused" | "buffering" | "error";

// The bridge from main/preload.cjs.
declare global {
  interface Window {
    flow: {
      get(key: string): unknown;
      set(key: string, value: unknown): void;
      status(state: { status: Status; station: string }): void;
      resize(height: number): void;
      hide(): void;
      title(url: string): Promise<string | null>;
      onToggle(listener: () => void): () => void;
      onShown(listener: () => void): () => void;
    };
  }
}

// The slice of the IFrame API used here.
type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  loadPlaylist(options: { list: string; listType: "playlist" }): void;
  loadPlaylist(playlist: string[], index: number, startSeconds: number): void;
  getCurrentTime(): number;
  getPlaylist(): string[] | null;
  getPlaylistIndex(): number;
  setShuffle(shuffle: boolean): void;
  setLoop(loop: boolean): void;
  // Undocumented, but the only way to tell a live stream from a link.
  getVideoData?(): { isLive?: boolean };
  destroy(): void;
};
type YTNamespace = {
  Player: new (
    el: HTMLElement,
    options: {
      width: number;
      height: number;
      playerVars: Record<string, number>;
      events: {
        onReady: () => void;
        onStateChange: (e: { data: number }) => void;
        onError: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
};
declare global {
  interface Window {
    YT?: YTNamespace & { loaded?: number };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;

let apiPromise: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  if (window.YT?.loaded) return Promise.resolve(window.YT);
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      apiPromise = null;
      reject(new Error("youtube api failed to load"));
    };
    const timer = setTimeout(fail, API_TIMEOUT_MS);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      clearTimeout(timer);
      resolve(window.YT!);
    };
    script.src = API_SRC;
    script.async = true;
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return apiPromise;
}

// Where each station was left. A playlist keeps its shuffled order, so the index still points at the same track.
type Position = { time: number; playlist?: string[]; index?: number };

function readPositions(): Record<string, Position> {
  return (window.flow.get(POSITIONS_KEY) as Record<string, Position> | null) ?? {};
}

function writePosition(id: string, position: Position | null) {
  const positions = readPositions();
  if (position) positions[id] = position;
  else delete positions[id];
  window.flow.set(POSITIONS_KEY, positions);
}

function rememberPosition(player: YTPlayer, station: Station) {
  if (station.live) return;
  const time = player.getCurrentTime();
  if ("video" in station) return writePosition(station.id, { time });
  const playlist = player.getPlaylist();
  if (playlist?.length) writePosition(station.id, { time, playlist, index: player.getPlaylistIndex() });
}

/** Loads the station, from where it was left when there is a position. Returns whether it resumed. */
function tune(player: YTPlayer, station: Station): boolean {
  const at = station.live ? undefined : readPositions()[station.id];
  if ("video" in station) {
    player.loadVideoById({ videoId: station.video, startSeconds: at?.time ?? 0 });
  } else if (at?.playlist?.length) {
    player.loadPlaylist(at.playlist, at.index ?? 0, at.time);
  } else {
    player.loadPlaylist({ list: station.playlist, listType: "playlist" });
  }
  return Boolean(at);
}

// The station list and the chosen station, persisted by the main process. The list is read once and kept
// here, so useSyncExternalStore sees the same array until it really changes.
const listeners = new Set<() => void>();
let stations: Station[] | null = null;

function readStations() {
  stations ??= (window.flow.get(STATIONS_KEY) as Station[] | null) ?? DEFAULT_STATIONS;
  return stations;
}

function saveStations(next: Station[]) {
  stations = next;
  window.flow.set(STATIONS_KEY, next);
  listeners.forEach((l) => l());
}

function readStation() {
  return (window.flow.get(STORAGE_KEY) as string | null) ?? null;
}

function saveStation(id: string) {
  window.flow.set(STORAGE_KEY, id);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A station from a pasted YouTube link: watch, youtu.be, live, shorts, embed and playlist links, or a bare id. */
function parseLink(text: string): { video: string } | { playlist: string } | null {
  const raw = text.trim();
  if (/^[\w-]{11}$/.test(raw)) return { video: raw };
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  const [first, second] = url.pathname.split("/").filter(Boolean);
  if (host === "youtu.be" && first) return { video: first };
  if (host !== "youtube.com") return null;
  const list = url.searchParams.get("list");
  const v = url.searchParams.get("v");
  // A Mix (`RD…`) is YouTube's own radio around a video, and it will not start in an embedded player: keep the video.
  if (list && !(list.startsWith("RD") && v)) return { playlist: list };
  if (v) return { video: v };
  if (["live", "shorts", "embed"].includes(first) && second) return { video: second };
  return null;
}

/** A YouTube title as a station name: lowercase, no emoji, cut at a word within LABEL_MAX. */
function tidyTitle(title: string) {
  const clean = title.replace(/\p{Extended_Pictographic}|\uFE0F/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (clean.length <= LABEL_MAX) return clean;
  const cut = clean.slice(0, LABEL_MAX);
  return cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : LABEL_MAX).replace(/[\s\p{P}]+$/u, "");
}

function canonicalUrl(source: { video: string } | { playlist: string }) {
  return "video" in source
    ? `https://www.youtube.com/watch?v=${source.video}`
    : `https://www.youtube.com/playlist?list=${source.playlist}`;
}

type Mode =
  | { kind: "list" }
  | { kind: "add"; busy?: boolean; error?: string }
  | { kind: "rename"; id: string }
  | { kind: "confirm"; action: "remove"; station: Station }
  | { kind: "confirm"; action: "rename"; station: Station; label: string };

export function Radio() {
  const [status, setStatus] = useState<Status>("idle");
  // Set when the station itself cannot play here, as opposed to a network or loading failure.
  const [blocked, setBlocked] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const list = useSyncExternalStore(subscribe, readStations);
  const storedId = useSyncExternalStore(subscribe, readStation);
  const station = list.find((s) => s.id === storedId) ?? list[0];

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  // Read by onReady, which may fire after a station change made during loading.
  const stationRef = useRef(station);
  // Shuffle and loop only take once a playlist is loaded, so they wait for its first play. A resumed playlist
  // is already in its saved shuffled order, so it only loops.
  const playlistSetup = useRef<"shuffle" | "loop" | null>(null);
  // The station loaded in the player and its last reported state, so a position is only saved once it has
  // really played that station.
  const tunedRef = useRef<Station | null>(null);
  const ytState = useRef<number | null>(null);
  // A row to focus once the list is back, after an edit or a confirm closes.
  const pendingFocus = useRef<number | null>(null);

  useEffect(() => {
    stationRef.current = station;
  }, [station]);

  useEffect(() => {
    window.flow.status({ status, station: station.label });
  }, [status, station]);

  // The window is sized to the panel.
  useEffect(() => {
    const root = rootRef.current!;
    const observer = new ResizeObserver(() => window.flow.resize(root.offsetHeight));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const remember = () => {
    const player = playerRef.current;
    const tuned = tunedRef.current;
    if (!player || !tuned || (ytState.current !== YT_PLAYING && ytState.current !== YT_PAUSED)) return;
    rememberPosition(player, tuned);
  };
  const rememberRef = useRef(remember);
  useEffect(() => {
    rememberRef.current = remember;
  });

  useEffect(() => {
    const onHide = () => rememberRef.current();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      rememberRef.current();
      playerRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    if (status !== "playing") return;
    const timer = setInterval(() => rememberRef.current(), SAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (mode.kind !== "list" || pendingFocus.current === null) return;
    optionRefs.current[pendingFocus.current]?.focus();
    pendingFocus.current = null;
  }, [mode]);

  // Each time the panel shows, start with nothing inverted: keys go to the panel until an arrow picks a row.
  useEffect(
    () =>
      window.flow.onShown(() => {
        setMode({ kind: "list" });
        rootRef.current?.focus();
      }),
    [],
  );

  const stallTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // YouTube reports a pause right after an error; once a station has failed, its later states are ignored.
  const failed = useRef(false);

  const tuneTo = (player: YTPlayer, next: Station) => {
    clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => {
      playerRef.current?.destroy();
      playerRef.current = null;
      setStatus("error");
    }, STALL_MS);
    tunedRef.current = next;
    ytState.current = null;
    failed.current = false;
    const resumed = tune(player, next);
    playlistSetup.current = "playlist" in next ? (resumed ? "loop" : "shuffle") : null;
  };

  const start = async () => {
    setStatus("loading");
    setBlocked(false);
    remember();
    playerRef.current?.destroy();
    playerRef.current = null;
    try {
      const YT = await loadApi();
      // The API replaces the element it is given, so hand it a fresh child.
      const el = document.createElement("div");
      hostRef.current!.replaceChildren(el);
      playerRef.current = new YT.Player(el, {
        width: PLAYER_SIZE,
        height: PLAYER_SIZE,
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1 },
        events: {
          onReady: () => playerRef.current && tuneTo(playerRef.current, stationRef.current),
          onStateChange: ({ data }) => {
            if (failed.current) return;
            ytState.current = data;
            if (data === YT_PLAYING && tunedRef.current && !tunedRef.current.live && playerRef.current?.getVideoData?.().isLive) {
              markLive(tunedRef.current);
            }
            if (data === YT_PLAYING) clearTimeout(stallTimer.current);
            if (data === YT_PLAYING && playlistSetup.current) {
              if (playlistSetup.current === "shuffle") playerRef.current?.setShuffle(true);
              playerRef.current?.setLoop(true);
              playlistSetup.current = null;
            }
            if (data === YT_PAUSED) rememberRef.current();
            // A finished video starts over next time. Playlists loop, so they never end.
            if (data === YT_ENDED && tunedRef.current && "video" in tunedRef.current) writePosition(tunedRef.current.id, null);
            setStatus(data === YT_PLAYING ? "playing" : data === YT_BUFFERING ? "buffering" : "paused");
          },
          onError: ({ data }) => {
            failed.current = true;
            clearTimeout(stallTimer.current);
            // 101 and 150: the owner does not allow playback outside youtube.com. 100: removed or private.
            setBlocked([100, 101, 150].includes(data));
            setStatus("error");
          },
        },
      });
    } catch {
      setStatus("error");
    }
  };

  const toggle = () => {
    const player = playerRef.current;
    if (status === "loading") return;
    if (status === "idle" || status === "error" || !player) void start();
    else if (status === "playing" || status === "buffering") {
      clearTimeout(stallTimer.current);
      player.pauseVideo();
    }
    else if (status === "paused") player.playVideo();
  };

  const choose = (next: Station) => {
    const player = playerRef.current;
    const live = player && status !== "idle" && status !== "error";
    if (next.id === station.id) {
      // Same station: just make sure it plays.
      if (!live) void start();
      else if (status === "paused") player.playVideo();
      return;
    }
    saveStation(next.id);
    stationRef.current = next;
    if (status === "loading") return; // onReady tunes to stationRef
    // A fresh player per station: a loaded player can keep the previous station's playlist when the next
    // one (a YouTube Mix, say) will not load into it, and that playlist would then be saved as the new one's.
    void start();
  };

  // A live stream has no position to resume; added stations only find out once they play.
  const markLive = (target: Station) => {
    const live = { ...target, live: true };
    tunedRef.current = live;
    writePosition(target.id, null);
    saveStations(readStations().map((s) => (s.id === target.id ? live : s)));
  };

  const add = async (text: string) => {
    const source = parseLink(text);
    if (!source) return setMode({ kind: "add", error: "not a youtube link" });
    setMode({ kind: "add", busy: true });
    const title = await window.flow.title(canonicalUrl(source));
    const label = title ? tidyTitle(title) || "new station" : "new station";
    const next = { id: `s-${Date.now().toString(36)}`, label, ...source } as Station;
    saveStations([...readStations(), next]);
    pendingFocus.current = readStations().length - 1;
    setMode({ kind: "list" });
  };

  const remove = (target: Station) => {
    const remaining = list.filter((s) => s.id !== target.id);
    const index = list.indexOf(target);
    // Removing the station on air stops it: the player would otherwise go on with a station that is gone.
    if (target.id === station.id) {
      if (tunedRef.current?.id === target.id) {
        playerRef.current?.destroy();
        playerRef.current = null;
        tunedRef.current = null;
        setStatus("idle");
      }
      saveStation(remaining[Math.min(index, remaining.length - 1)].id);
    }
    writePosition(target.id, null);
    saveStations(remaining);
    pendingFocus.current = Math.min(index, remaining.length - 1);
  };

  const rename = (target: Station, label: string) => {
    saveStations(list.map((s) => (s.id === target.id ? { ...s, label } : s)));
    pendingFocus.current = list.indexOf(target);
  };

  const confirm = () => {
    if (mode.kind !== "confirm") return;
    if (mode.action === "remove") remove(mode.station);
    else rename(mode.station, mode.label);
    setMode({ kind: "list" });
  };

  const back = (index: number) => {
    pendingFocus.current = index;
    setMode({ kind: "list" });
  };

  const askRemove = (target: Station) => {
    if (list.length > 1) setMode({ kind: "confirm", action: "remove", station: target });
  };

  // The tray's play/pause item.
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => window.flow.onToggle(() => toggleRef.current()), []);

  // The rows: every station, then `add station`.
  const focusOption = (index: number) => {
    const n = list.length + 1;
    optionRefs.current[(index + n) % n]?.focus();
  };

  // Keys that reach the panel itself, before any row has focus.
  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      window.flow.hide();
    } else if (e.target !== e.currentTarget) {
      return;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      focusOption(list.indexOf(station));
    }
  };

  const onButtonKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      focusOption(e.key === "ArrowUp" ? list.length : 0);
    }
  };

  const onOptionKey = (e: React.KeyboardEvent, index: number) => {
    const moves: Record<string, number> = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: list.length };
    const target = list[index];
    if (e.key in moves) {
      e.preventDefault();
      focusOption(moves[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (target) choose(target);
      else setMode({ kind: "add" });
    } else if (target && (e.key === "e" || e.key === "F2")) {
      e.preventDefault();
      setMode({ kind: "rename", id: target.id });
    } else if (target && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      askRemove(target);
    }
  };

  const on = status === "playing" || status === "buffering" || status === "loading";
  const playing = status === "playing" || status === "buffering";
  // The accessible name stays put; aria-pressed carries play vs pause.
  const label = status === "error" ? "radio failed, retry" : "radio";

  return (
    <>
      <div
        ref={rootRef}
        tabIndex={-1}
        onKeyDown={onPanelKey}
        onPointerLeave={() => {
          // Drops the inverted row the mouse left behind; a field or confirm being typed in keeps its focus.
          if (document.activeElement?.closest("[role=menu] button")) rootRef.current?.focus();
        }}
        className={cn(
          "radio-frame flex w-radio-panel flex-col items-stretch rounded-md bg-status text-text outline-none",
          playing && "radio-live",
        )}
      >
        <div className="flex items-center gap-3 border-b border-accent/30 px-3 pt-3 pb-2">
          <Equalizer live={playing} />
          <span className="min-w-0 flex-1 truncate text-11 font-semibold tracking-widest uppercase">
            {blocked && status === "error" ? (
              <span className="text-danger">not playable outside youtube </span>
            ) : (
              <span className="text-text-dim">{on ? "on air" : "tuned"} </span>
            )}
            <span className="radio-text">{station.label}</span>
          </span>
        </div>
        {mode.kind === "confirm" ? (
          <Confirm
            question={
              mode.action === "remove" ? (
                <>
                  remove <span className="radio-text">{mode.station.label}</span>?
                </>
              ) : (
                <>
                  rename <span className="text-text-muted">{mode.station.label}</span> to{" "}
                  <span className="radio-text">{mode.label}</span>?
                </>
              )
            }
            verb={mode.action}
            onConfirm={confirm}
            onCancel={() => back(list.indexOf(mode.station))}
          />
        ) : (
          <div role="menu" aria-label="stations" className="flex flex-col py-1">
            {list.map((s, i) => {
              const current = s.id === station.id;
              if (mode.kind === "rename" && mode.id === s.id) {
                return (
                  <Field
                    key={s.id}
                    number={i + 1}
                    initial={s.label}
                    placeholder="station name"
                    onSubmit={(value) => {
                      const label = value.trim().slice(0, LABEL_MAX);
                      if (!label || label === s.label) back(i);
                      else setMode({ kind: "confirm", action: "rename", station: s, label });
                    }}
                    onCancel={() => back(i)}
                  />
                );
              }
              return (
                <div
                  key={s.id}
                  className={cn(
                    "group flex h-row items-center focus-within:radio-fill",
                    current ? "text-text" : "text-text-muted",
                  )}
                >
                  <button
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current}
                    tabIndex={-1}
                    onClick={() => choose(s)}
                    onKeyDown={(e) => onOptionKey(e, i)}
                    onPointerMove={(e) => e.currentTarget.focus({ preventScroll: true })}
                    className={cn(
                      "flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left text-12 font-semibold tracking-wider whitespace-nowrap uppercase outline-none",
                      // Focus inverts the row: the gradient becomes the fill and the text goes black.
                      "group-focus-within:text-status",
                    )}
                  >
                    <span className="w-5 shrink-0 text-11 text-text-dim tabular-nums group-focus-within:text-status">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        current && "radio-text group-focus-within:text-status group-focus-within:[background:none]",
                      )}
                    >
                      {s.label}
                    </span>
                    {current ? (
                      <span
                        aria-hidden
                        className={cn(
                          "size-2 shrink-0 rounded-full bg-accent group-focus-within:hidden",
                          playing && "animate-pulse",
                        )}
                      />
                    ) : null}
                  </button>
                  {/* Edit and remove show on the inverted row only, so the list at rest stays the original. */}
                  <span className="hidden items-center gap-1 pr-2 pl-1 group-focus-within:flex">
                    <RowAction label={`rename ${s.label}`} onClick={() => setMode({ kind: "rename", id: s.id })}>
                      <Pencil aria-hidden className="size-3" strokeWidth={2} />
                    </RowAction>
                    {list.length > 1 ? (
                      <RowAction label={`remove ${s.label}`} onClick={() => askRemove(s)}>
                        <Trash2 aria-hidden className="size-3" strokeWidth={2} />
                      </RowAction>
                    ) : null}
                  </span>
                </div>
              );
            })}
            {mode.kind === "add" ? (
              <>
                <Field
                  number={list.length + 1}
                  placeholder={mode.busy ? "adding…" : "paste a youtube link"}
                  disabled={mode.busy}
                  onSubmit={(value) => (value.trim() ? void add(value) : back(list.length))}
                  onCancel={() => back(list.length)}
                  onChange={() => mode.error && setMode({ kind: "add" })}
                />
                {mode.error ? <p className="px-3 pb-1 pl-11 text-11 text-danger">{mode.error}</p> : null}
              </>
            ) : (
              <button
                ref={(el) => {
                  optionRefs.current[list.length] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => setMode({ kind: "add" })}
                onKeyDown={(e) => onOptionKey(e, list.length)}
                onPointerMove={(e) => e.currentTarget.focus({ preventScroll: true })}
                className="group flex h-row items-center gap-3 px-3 text-left text-12 font-semibold tracking-wider whitespace-nowrap text-text-dim uppercase outline-none focus:radio-fill focus:text-status"
              >
                <span className="flex w-5 justify-center">
                  <Plus aria-hidden className="size-3" strokeWidth={2} />
                </span>
                add station
              </button>
            )}
          </div>
        )}
        <div className="flex border-t border-accent/30">
          <button
            ref={buttonRef}
            type="button"
            onClick={toggle}
            onKeyDown={onButtonKey}
            aria-label={label}
            aria-pressed={on}
            className={cn(
              // 24px tall, no fill: the gradient label carries the state.
              "my-1 flex h-6 items-center justify-center gap-2 self-center mx-auto rounded-sm border border-transparent px-2 text-11 text-text-muted transition-colors duration-80 ease-snap outline-none hover:text-text focus-visible:border-accent",
              on && "text-text",
              status === "error" && "text-danger hover:text-danger",
            )}
          >
            {status === "error" ? (
              <RotateCw aria-hidden className="size-3" strokeWidth={1.5} />
            ) : (
              // The same equalizer in every state: still when stopped, paused or loading, bouncing while it plays.
              <Equalizer live={status === "playing"} />
            )}
            <span className={cn(status !== "error" && "radio-text", playing && "radio-live")}>
              {status === "error" ? "retry" : on ? "Flow Ongoing" : "Get in Flow"}
            </span>
          </button>
        </div>
      </div>
      {/* Clipped to 1px rather than display:none, which stops playback. Inert keeps the iframe out of tab order. */}
      <div inert className="fixed right-0 bottom-0 size-px overflow-hidden opacity-0">
        <div ref={hostRef} />
      </div>
    </>
  );
}

/** A row's inline text field, for a new station's link or a new name. Enter submits, esc cancels. */
function Field({
  number,
  initial = "",
  placeholder,
  disabled,
  onSubmit,
  onCancel,
  onChange,
}: {
  number: number;
  initial?: string;
  placeholder: string;
  disabled?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  onChange?: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <label className="flex h-row items-center gap-3 px-3">
      <span className="w-5 shrink-0 text-11 text-text-dim tabular-nums">{String(number).padStart(2, "0")}</span>
      <input
        autoFocus
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          } else if (e.key === "Escape") {
            // Cancels the edit instead of closing the panel.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        className="h-6 min-w-0 flex-1 border-b border-accent bg-transparent text-12 text-text outline-none placeholder:text-text-dim disabled:text-text-dim"
      />
    </label>
  );
}

/** The confirm step for renames and removals, in place of the list. Enter confirms, esc goes back. */
function Confirm({
  question,
  verb,
  onConfirm,
  onCancel,
}: {
  question: React.ReactNode;
  verb: "remove" | "rename";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  const button =
    "h-6 rounded-sm border px-2 text-11 font-semibold tracking-wider uppercase outline-none transition-colors duration-80 ease-snap";
  return (
    <div
      role="alertdialog"
      aria-label={`${verb} station`}
      className="flex flex-col gap-3 px-3 py-3"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <p className="text-12 font-semibold tracking-wider break-words text-text uppercase">{question}</p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(button, "border-text-dim text-text-muted hover:text-text focus-visible:border-accent")}
        >
          cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className={cn(
            button,
            verb === "remove"
              ? "border-danger text-danger hover:bg-danger hover:text-status focus:bg-danger focus:text-status"
              : "border-accent text-accent hover:radio-fill hover:text-status focus:radio-fill focus:text-status",
          )}
        >
          {verb}
        </button>
      </div>
    </div>
  );
}

/** Edit and remove on an inverted station row, black on the gradient. */
function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-sm text-status outline-none hover:bg-status/15"
    >
      {children}
    </button>
  );
}

/** Five bars bouncing out of phase while it plays, resting low when paused. */
function Equalizer({ live }: { live: boolean }) {
  return (
    <span aria-hidden className="flex h-3 items-end gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn("radio-bar h-full w-0.5 origin-bottom", live && "radio-live")}
          style={{ animationDelay: `${-i * 170}ms` }}
        />
      ))}
    </span>
  );
}

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
