const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PANEL_WIDTH = 280;
// Gap between the menu bar and the panel.
const PANEL_OFFSET = 4;
// A click on the tray while the panel is open blurs it first; ignore the reopen that follows.
const REOPEN_GUARD_MS = 250;
const FRAME_MS = 60;

// The panel plays from the tray menu too, which is no user gesture inside the page.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// YouTube serves its plain player to a plain Chrome user agent.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|flow-radio)\/\S+/g, "");

if (!app.requestSingleInstanceLock()) app.quit();

/* Persistence: a JSON file in userData, read once, written on change. */
const storePath = path.join(app.getPath("userData"), "store.json");
let store = {};
try {
  store = JSON.parse(fs.readFileSync(storePath, "utf8"));
} catch {}

ipcMain.on("store:get", (e, key) => {
  e.returnValue = store[key] ?? null;
});
ipcMain.on("store:set", (_e, key, value) => {
  store[key] = value;
  fs.writeFile(storePath, JSON.stringify(store), () => {});
});

/* The page is served over http so YouTube's embed gets a real origin and referrer; file:// gets refused. */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };

function serve() {
  const root = path.join(__dirname, "..", "dist");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = path.join(root, path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/* The tray icon: the panel's five-bar equalizer as an 18pt template image, bouncing while it plays. */
const ICON_PX = 36;
const BAR_W = 4;
const BAR_GAP = 3;
const BAR_MAX = 24;

function equalizer(levels) {
  const buf = Buffer.alloc(ICON_PX * ICON_PX * 4);
  const left = (ICON_PX - (5 * BAR_W + 4 * BAR_GAP)) / 2;
  const bottom = (ICON_PX + BAR_MAX) / 2;
  levels.forEach((level, i) => {
    const height = Math.round(level * BAR_MAX);
    const x0 = left + i * (BAR_W + BAR_GAP);
    for (let y = bottom - height; y < bottom; y++) {
      for (let x = x0; x < x0 + BAR_W; x++) buf[(y * ICON_PX + x) * 4 + 3] = 255;
    }
  });
  const image = nativeImage.createFromBitmap(buf, { width: ICON_PX, height: ICON_PX, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

// Same motion as the CSS bars: 420ms ease-in-out between 25% and full, alternating, each bar 170ms ahead.
function levelsAt(t) {
  return [0, 1, 2, 3, 4].map((i) => {
    let p = ((t + i * 170) % 840) / 420;
    if (p > 1) p = 2 - p;
    return 0.25 + 0.75 * (0.5 - 0.5 * Math.cos(Math.PI * p));
  });
}

const RESTING = equalizer([0.25, 0.25, 0.25, 0.25, 0.25]);

let tray;
let win;
let hiddenAt = 0;
let state = { status: "idle", station: "" };
let animation;

function setAnimating(on) {
  if (on && !animation) {
    const started = Date.now();
    animation = setInterval(() => tray.setImage(equalizer(levelsAt(Date.now() - started))), FRAME_MS);
  } else if (!on && animation) {
    clearInterval(animation);
    animation = undefined;
    tray.setImage(RESTING);
  }
}

const playing = () => state.status === "playing" || state.status === "buffering";

function headline() {
  if (state.status === "error") return "Radio failed";
  const on = playing() || state.status === "loading";
  return `${on ? "Flow Ongoing" : "Get in Flow"} · ${state.station}`;
}

ipcMain.on("status", (_e, next) => {
  state = next;
  setAnimating(state.status === "playing");
  tray.setToolTip(headline());
});

ipcMain.on("resize", (_e, height) => {
  win.setContentSize(PANEL_WIDTH, Math.ceil(height));
});

ipcMain.on("hide", () => win.hide());

function showPanel() {
  const bounds = tray.getBounds();
  const x = Math.round(bounds.x + bounds.width / 2 - PANEL_WIDTH / 2);
  win.setPosition(x, bounds.y + bounds.height + PANEL_OFFSET);
  win.show();
  win.focus();
  win.webContents.send("shown");
}

function togglePanel() {
  if (win.isVisible()) return win.hide();
  if (Date.now() - hiddenAt < REOPEN_GUARD_MS) return;
  showPanel();
}

function contextMenu() {
  const on = playing() || state.status === "loading";
  return Menu.buildFromTemplate([
    { label: headline(), enabled: false },
    { label: on ? "Pause" : "Play", click: () => win.webContents.send("toggle") },
    { type: "separator" },
    {
      label: "Open at Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: "Quit Flow Radio", role: "quit" },
  ]);
}

app.whenReady().then(async () => {
  app.dock?.hide();
  const port = await serve();

  win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      // Keeps the player running while the panel is hidden.
      backgroundThrottling: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on("blur", () => {
    if (!win.isVisible()) return;
    hiddenAt = Date.now();
    win.hide();
  });
  win.loadURL(`http://127.0.0.1:${port}/`);

  tray = new Tray(RESTING);
  tray.setToolTip("Get in Flow");
  tray.on("click", togglePanel);
  tray.on("right-click", () => tray.popUpContextMenu(contextMenu()));
});

app.on("second-instance", () => win && showPanel());
app.on("window-all-closed", (e) => e.preventDefault());
