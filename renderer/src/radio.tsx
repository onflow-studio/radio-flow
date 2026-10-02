import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Background audio from YouTube, the station panel from superfer's radio hanging from the menu bar. The
 * window only hides, never closes, so playback survives the panel going away. Nothing loads from YouTube
 * until the first play. Each station resumes where it was left, across restarts; live streams have nothing
 * to resume.
 */
type Station = { id: string; label: string; live?: boolean } & ({ video: string } | { playlist: string });

const STATIONS: Station[] = [
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
const POSITIONS_KEY = "radio-positions";
const SAVE_INTERVAL_MS = 5_000;

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

// The chosen station, persisted by the main process.
const stationListeners = new Set<() => void>();

function readStation() {
  return (window.flow.get(STORAGE_KEY) as string | null) ?? null;
}

function saveStation(id: string) {
  window.flow.set(STORAGE_KEY, id);
  stationListeners.forEach((l) => l());
}

function subscribeStation(listener: () => void) {
  stationListeners.add(listener);
  return () => stationListeners.delete(listener);
}

export function Radio() {
  const [status, setStatus] = useState<Status>("idle");
  const storedId = useSyncExternalStore(subscribeStation, readStation);
  const station = STATIONS.find((s) => s.id === storedId) ?? STATIONS[0];

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

  // Each time the panel shows, start with nothing inverted: keys go to the panel until an arrow picks a row.
  useEffect(() => window.flow.onShown(() => rootRef.current?.focus()), []);

  const tuneTo = (player: YTPlayer, next: Station) => {
    tunedRef.current = next;
    ytState.current = null;
    const resumed = tune(player, next);
    playlistSetup.current = "playlist" in next ? (resumed ? "loop" : "shuffle") : null;
  };

  const start = async () => {
    setStatus("loading");
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
            ytState.current = data;
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
          onError: () => setStatus("error"),
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
    else if (status === "playing" || status === "buffering") player.pauseVideo();
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
    if (live) {
      remember();
      setStatus("buffering");
      tuneTo(player, next);
    } else void start();
  };

  // The tray's play/pause item.
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => window.flow.onToggle(() => toggleRef.current()), []);

  const focusOption = (index: number) => {
    const n = STATIONS.length;
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
      focusOption(STATIONS.indexOf(station));
    }
  };

  const onButtonKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      focusOption(e.key === "ArrowUp" ? STATIONS.length - 1 : 0);
    }
  };

  const onOptionKey = (e: React.KeyboardEvent, index: number) => {
    const moves: Record<string, number> = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: STATIONS.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      focusOption(moves[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(STATIONS[index]);
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
          if (rootRef.current?.contains(document.activeElement)) rootRef.current.focus();
        }}
        className={cn(
          "radio-frame flex w-radio-panel flex-col items-stretch rounded-md bg-status text-text outline-none",
          playing && "radio-live",
        )}
      >
        <div className="flex items-center gap-3 border-b border-accent/30 px-3 pt-3 pb-2">
          <Equalizer live={playing} />
          <span className="min-w-0 flex-1 truncate text-11 font-semibold tracking-widest uppercase">
            <span className="text-text-dim">{on ? "on air" : "tuned"} </span>
            <span className="radio-text">{station.label}</span>
          </span>
        </div>
        <div role="menu" aria-label="stations" className="flex flex-col py-1">
          {STATIONS.map((s, i) => {
            const current = s.id === station.id;
            return (
              <button
                key={s.id}
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
                  "group flex h-row items-center gap-3 px-3 text-left text-12 font-semibold tracking-wider whitespace-nowrap uppercase outline-none",
                  // Focus inverts the row: the gradient becomes the fill and the text goes black.
                  "focus:radio-fill focus:text-status",
                  current ? "text-text" : "text-text-muted",
                )}
              >
                <span className="w-5 text-11 text-text-dim tabular-nums group-focus:text-status">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={cn("flex-1", current && "radio-text group-focus:text-status group-focus:[background:none]")}>
                  {s.label}
                </span>
                {current ? (
                  <span aria-hidden className={cn("size-2 rounded-full bg-accent group-focus:bg-status", playing && "animate-pulse")} />
                ) : null}
              </button>
            );
          })}
        </div>
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
