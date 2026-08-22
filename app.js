// ---------------------------------------------------------------------------
// Needle Drop — Heardle-style guessing game powered by the real Spotify
// Web Playback SDK + Web API. Requires Spotify Premium. The redirect URI is
// derived from wherever this page is actually loaded from (localhost during
// development, the GitHub Pages URL in production) — register both exact
// URLs in the Spotify app's dashboard under Redirect URIs.
// ---------------------------------------------------------------------------

const CLIENT_ID = "86ad66b6193946019291f81969b513d4";

// Normalized so it always lands on the same string regardless of how the
// page was reached (with/without trailing slash, or via index.html) — that
// string must match a Redirect URI registered in the Spotify dashboard.
function computeRedirectUri() {
  let path = window.location.pathname.replace(/index\.html?$/, "");
  if (!path.endsWith("/")) path += "/";
  return window.location.origin + path;
}
const REDIRECT_URI = computeRedirectUri();
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-library-read",
].join(" ");

const SNIPPETS_MS = [100, 1000, 2000, 4000, 7000, 11000, 16000];
const MAX_ATTEMPTS = SNIPPETS_MS.length;
const TOTAL_MS = SNIPPETS_MS[MAX_ATTEMPTS - 1];

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const screenLogin = $("screen-login");
const screenGame = $("screen-game");
const btnLogin = $("btn-login");
const loginError = $("login-error");
const accountPill = $("account-pill");
const accountName = $("account-name");

const playlistInput = $("playlist-input");
const btnPool = $("btn-pool");
const poolStatus = $("pool-status");

const btnPlay = $("btn-play");
const iconPlay = $("icon-play");
const iconPause = $("icon-pause");
const timelineFill = $("timeline-fill");
const timelineTickEls = [...document.querySelectorAll(".timeline-ticks span")];
const timelineLabelEls = [...document.querySelectorAll(".timeline-labels span")];
const dialReadoutValue = $("dial-readout-value");
const volumeSlider = $("volume-slider");

const attemptsRow = $("attempts-row");
const guessInput = $("guess-input");
const guessSuggestions = $("guess-suggestions");
const btnSubmit = $("btn-submit");
const btnSkip = $("btn-skip");

const reveal = $("reveal");
const revealArt = $("reveal-art");
const revealResult = $("reveal-result");
const revealTitle = $("reveal-title");
const revealArtist = $("reveal-artist");
const revealOpen = $("reveal-open");
const btnFull = $("btn-full");
const btnCopy = $("btn-copy");
const btnNext = $("btn-next");
const gameStatus = $("game-status");

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(digest);
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------
const store = {
  get access() { return localStorage.getItem("nd_access_token"); },
  get refresh() { return localStorage.getItem("nd_refresh_token"); },
  get expiresAt() { return Number(localStorage.getItem("nd_expires_at") || 0); },
  set(access, refresh, expiresIn) {
    localStorage.setItem("nd_access_token", access);
    if (refresh) localStorage.setItem("nd_refresh_token", refresh);
    localStorage.setItem("nd_expires_at", String(Date.now() + expiresIn * 1000 - 5000));
  },
  clear() {
    localStorage.removeItem("nd_access_token");
    localStorage.removeItem("nd_refresh_token");
    localStorage.removeItem("nd_expires_at");
  },
};

async function startLogin() {
  if (!CLIENT_ID || CLIENT_ID === "PASTE_YOUR_CLIENT_ID_HERE") {
    showLoginError("Keine Spotify Client-ID hinterlegt. Trag sie in app.js (CLIENT_ID) ein.");
    return;
  }
  const verifier = randomString(64);
  sessionStorage.setItem("nd_verifier", verifier);
  const challenge = await pkceChallenge(verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
    show_dialog: "true",
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function exchangeCode(code) {
  const verifier = sessionStorage.getItem("nd_verifier");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Token-Austausch fehlgeschlagen");
  const data = await res.json();
  store.set(data.access_token, data.refresh_token, data.expires_in);
}

async function refreshToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: store.refresh,
    client_id: CLIENT_ID,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Refresh fehlgeschlagen");
  const data = await res.json();
  store.set(data.access_token, data.refresh_token || store.refresh, data.expires_in);
}

async function getValidToken() {
  if (!store.access) return null;
  if (Date.now() >= store.expiresAt && store.refresh) {
    await refreshToken();
  }
  return store.access;
}

async function api(path, opts = {}) {
  const token = await getValidToken();
  const res = await fetch(
    path.startsWith("http") ? path : `https://api.spotify.com/v1${path}`,
    { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } }
  );
  if (res.status === 401 && store.refresh) {
    await refreshToken();
    return api(path, opts);
  }
  return res;
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Spotify Web Playback SDK
// ---------------------------------------------------------------------------
let player = null;
let deviceId = null;
let sdkReady = false;

function getSavedVolume() {
  const raw = Number(localStorage.getItem("nd_volume"));
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 80;
}

window.onSpotifyWebPlaybackSDKReady = () => {
  sdkReady = true;
  initPlayer();
};

function initPlayer() {
  if (!sdkReady || player || !store.access) return;
  player = new Spotify.Player({
    name: "Needle Drop",
    getOAuthToken: (cb) => getValidToken().then(cb),
    volume: getSavedVolume() / 100,
  });

  player.addListener("ready", async ({ device_id }) => {
    deviceId = device_id;
    await api("/me/player", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [device_id], play: false }),
    });
    gameStatus.textContent = "Bereit.";
  });

  player.addListener("initialization_error", ({ message }) => showLoginError(message));
  player.addListener("authentication_error", ({ message }) => showLoginError(message));
  player.addListener("account_error", () =>
    showLoginError("Spotify Premium wird für die Wiedergabe benötigt.")
  );
  player.addListener("playback_error", ({ message }) => {
    gameStatus.textContent = `Wiedergabefehler: ${message}`;
  });

  player.connect();
}

async function playFrom(uri, positionMs = 0) {
  await api(`/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uris: [uri], position_ms: positionMs }),
  });
}

async function pausePlayback() {
  await api(`/me/player/pause?device_id=${deviceId}`, { method: "PUT" });
}

// ---------------------------------------------------------------------------
// Playlist / track pool
// ---------------------------------------------------------------------------
let pool = [];
let poolLabel = "Liked Songs";
let drawQueue = []; // shuffled draw order; refilled+reshuffled once emptied

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Draws without repeats until the whole pool has been seen once, then
// reshuffles — so the round order actually changes each time instead of
// plain Math.random() occasionally handing back a song you just had.
function nextAnswer() {
  if (drawQueue.length === 0) drawQueue = shuffled(pool);
  return drawQueue.pop();
}

async function loadLikedSongs() {
  poolStatus.textContent = "Lade …";
  let items = [];
  let url = "/me/tracks?limit=50";
  while (url) {
    const res = await api(url);
    if (!res.ok) {
      if (items.length === 0) {
        poolStatus.textContent = "Liked Songs konnten nicht geladen werden";
        return false;
      }
      break;
    }
    const data = await res.json();
    items = items.concat(data.items.map((it) => it.track));
    poolStatus.textContent = `Lade … ${items.length} Songs`;
    url = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
  }
  pool = items.filter((t) => t && t.id && t.uri && t.uri.startsWith("spotify:track:"));
  if (pool.length < 4) {
    poolStatus.textContent = "Zu wenig Liked Songs (mind. 4 nötig) — versuch Künstler/Genre";
    return false;
  }
  poolLabel = "Liked Songs";
  poolStatus.textContent = `${poolLabel} · ${pool.length} Songs`;
  drawQueue = [];
  return true;
}

// This app's client is capped at limit=10 per search request (Spotify
// Development Mode quota) — page through offsets to build a decent pool.
async function loadSearchPool(query) {
  poolStatus.textContent = "Lade …";
  let items = [];
  for (let offset = 0; offset < 50; offset += 10) {
    const res = await api(
      `/search?type=track&limit=10&offset=${offset}&q=${encodeURIComponent(query)}`
    );
    if (!res.ok) {
      if (items.length === 0) {
        poolStatus.textContent = "Suche fehlgeschlagen";
        return false;
      }
      break;
    }
    const data = await res.json();
    const batch = data.tracks?.items || [];
    items = items.concat(batch);
    poolStatus.textContent = `Lade … ${items.length} Songs`;
    if (batch.length < 10) break;
  }
  pool = items.filter((t) => t && t.id && t.uri && t.uri.startsWith("spotify:track:"));
  if (pool.length < 4) {
    poolStatus.textContent = "Zu wenig Treffer für diese Suche";
    return false;
  }
  poolLabel = query;
  poolStatus.textContent = `"${poolLabel}" · ${pool.length} Songs`;
  drawQueue = [];
  return true;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let answer = null;
let attempt = 0;
let history = []; // { type: 'wrong'|'skip'|'correct', label }
let gameOver = false;

// revealedMs = the high-water mark of how much of the track has been
// revealed so far (contiguous from 0). The manual Play button always
// replays everything revealed so far from position 0; only Skip's
// auto-continuation picks up from here to play just the newly added slice.
let revealedMs = 0;
let playBaseMs = 0; // where the *current* segment's playback started from
let segmentStartPerf = null;
let isPlaying = false;
let stopTimer = null;
let rafId = null;
let segmentToken = 0; // bumped on every new segment so a stale async call can detect it was superseded

function liveRevealedMs() {
  if (!isPlaying || segmentStartPerf == null) return revealedMs;
  return Math.min(TOTAL_MS, playBaseMs + (performance.now() - segmentStartPerf));
}

function currentTargetMs() {
  return SNIPPETS_MS[attempt];
}

function renderDial(liveMs) {
  const ms = liveMs ?? liveRevealedMs();
  timelineFill.style.width = Math.min(100, (ms / TOTAL_MS) * 100) + "%";
  dialReadoutValue.textContent = (ms / 1000).toFixed(1);
}

function runFillLoop() {
  cancelAnimationFrame(rafId);
  const step = () => {
    renderDial();
    if (isPlaying) rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function resetPlayButtonIcon() {
  iconPlay.classList.remove("hidden");
  iconPause.classList.add("hidden");
  btnPlay.classList.remove("playing");
}

function scheduleAutoStop(myToken) {
  clearTimeout(stopTimer);
  const target = currentTargetMs();
  const remaining = Math.max(0, target - liveRevealedMs());
  stopTimer = setTimeout(async () => {
    if (myToken !== segmentToken) return; // a newer segment already took over
    revealedMs = target;
    isPlaying = false;
    cancelAnimationFrame(rafId);
    renderDial(revealedMs);
    resetPlayButtonIcon();
    btnPlay.disabled = false;
    await pausePlayback().catch(() => {});
  }, remaining);
}

async function beginSegment(baseMs) {
  if (!deviceId || !answer || gameOver || isPlaying) return;
  isPlaying = true;
  playBaseMs = baseMs;
  const myToken = ++segmentToken;
  btnPlay.disabled = true; // the literal fix for spamming Play: it just can't be clicked again mid-clip
  iconPlay.classList.add("hidden");
  iconPause.classList.remove("hidden");
  btnPlay.classList.add("playing");
  try {
    await playFrom(answer.uri, baseMs);
  } catch (e) {
    if (myToken !== segmentToken) return; // superseded while this request was in flight
    gameStatus.textContent = "Konnte nicht abspielen — Spotify-App evtl. woanders aktiv?";
    isPlaying = false;
    btnPlay.disabled = false;
    resetPlayButtonIcon();
    return;
  }
  if (myToken !== segmentToken) return; // superseded while this request was in flight
  // Stamp the clock here, once Spotify has actually acknowledged the play
  // command, instead of before awaiting it — otherwise network latency eats
  // into the snippet's timing budget.
  segmentStartPerf = performance.now();
  scheduleAutoStop(myToken);
  runFillLoop();
}

// Manual Play button — always replays from the very start of the track.
function startPlayback() {
  return beginSegment(0);
}

// Used right after a Skip when nothing is currently playing — picks up
// exactly where the last segment stopped instead of restarting from zero.
function continueFromLastStop() {
  return beginSegment(revealedMs);
}

// Stops the JS-side timer/animation and, if still playing, pauses Spotify
// and commits the live position into revealedMs. Used for game-over cleanup.
function haltPlayback() {
  segmentToken++; // invalidate any in-flight beginSegment/scheduleAutoStop
  clearTimeout(stopTimer);
  cancelAnimationFrame(rafId);
  if (isPlaying) {
    revealedMs = liveRevealedMs();
    pausePlayback().catch(() => {});
  }
  isPlaying = false;
  btnPlay.disabled = false;
  resetPlayButtonIcon();
}

function renderAttempts() {
  attemptsRow.innerHTML = "";
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const slot = document.createElement("div");
    slot.className = "attempt-slot";
    const h = history[i];
    if (h) {
      slot.classList.add(h.type, "just-set");
      slot.textContent = h.type === "skip" ? "Skip" : h.label;
    } else if (i === attempt) {
      slot.classList.add("current");
      slot.textContent = `${SNIPPETS_MS[i] / 1000}s`;
    } else {
      slot.textContent = `${SNIPPETS_MS[i] / 1000}s`;
    }
    attemptsRow.appendChild(slot);
  }

  timelineTickEls.forEach((tick, i) => {
    tick.classList.toggle("active", i === attempt && !gameOver);
    tick.classList.toggle("spent", i < attempt);
  });
  timelineLabelEls.forEach((label, i) => {
    label.classList.toggle("active", i === attempt && !gameOver);
    label.classList.toggle("spent", i < attempt);
  });
}

function newRound() {
  haltPlayback();
  revealedMs = 0;
  playBaseMs = 0;
  renderDial(0);

  answer = nextAnswer();
  attempt = 0;
  history = [];
  gameOver = false;

  guessInput.value = "";
  guessInput.disabled = false;
  btnSubmit.disabled = false;
  btnSkip.disabled = false;
  btnPlay.disabled = false;
  selectedGuess = null;
  guessSuggestions.classList.add("hidden");

  reveal.classList.add("hidden");
  gameStatus.textContent = "Neue Runde — viel Erfolg.";
  renderAttempts();
}

let selectedGuess = null;
let searchDebounce = null;

async function searchTracks(q) {
  const res = await api(`/search?type=track&limit=8&q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.tracks?.items || [];
}

guessInput.addEventListener("input", () => {
  selectedGuess = null;
  const q = guessInput.value.trim();
  clearTimeout(searchDebounce);
  if (!q) {
    guessSuggestions.classList.add("hidden");
    return;
  }
  searchDebounce = setTimeout(async () => {
    const results = await searchTracks(q);
    renderSuggestions(results);
  }, 280);
});

function renderSuggestions(tracks) {
  guessSuggestions.innerHTML = "";
  if (!tracks.length) {
    guessSuggestions.classList.add("hidden");
    return;
  }
  tracks.forEach((t, i) => {
    const li = document.createElement("li");
    if (i === 0) li.classList.add("active");
    const title = document.createElement("div");
    title.className = "sug-title";
    title.textContent = t.name;
    const artist = document.createElement("div");
    artist.className = "sug-artist";
    artist.textContent = t.artists.map((a) => a.name).join(", ");
    li.appendChild(title);
    li.appendChild(artist);
    li.addEventListener("click", () => selectSuggestion(t));
    guessSuggestions.appendChild(li);
  });
  guessSuggestions.classList.remove("hidden");
}

function selectSuggestion(track) {
  selectedGuess = track;
  guessInput.value = `${track.name} — ${track.artists.map((a) => a.name).join(", ")}`;
  guessSuggestions.classList.add("hidden");
}

guessInput.addEventListener("keydown", (e) => {
  const items = [...guessSuggestions.querySelectorAll("li")];
  if (!items.length || guessSuggestions.classList.contains("hidden")) {
    if (e.key === "Enter") { e.preventDefault(); submitGuess(); }
    return;
  }
  let idx = items.findIndex((li) => li.classList.contains("active"));
  if (e.key === "ArrowDown") {
    e.preventDefault();
    items[idx]?.classList.remove("active");
    idx = (idx + 1) % items.length;
    items[idx].classList.add("active");
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    items[idx]?.classList.remove("active");
    idx = (idx - 1 + items.length) % items.length;
    items[idx].classList.add("active");
  } else if (e.key === "Enter") {
    e.preventDefault();
    const active = items[idx] || items[0];
    active?.click();
  }
});

document.addEventListener("click", (e) => {
  if (!guessSuggestions.contains(e.target) && e.target !== guessInput) {
    guessSuggestions.classList.add("hidden");
  }
});

// Strips the parts of a track title that differ between otherwise-identical
// releases (remaster tags, "feat.", single/album/radio edit suffixes, …) so
// e.g. the album cut and the single version of the same song compare equal.
function normalizeTitle(name) {
  return name
    .toLowerCase()
    .replace(/[\(\[][^)\]]*(feat\.?|with|remaster|version|edit|mix|mono|stereo|live|deluxe|explicit|clean|anniversary)[^)\]]*[\)\]]/gi, "")
    .replace(/\s*-\s*(remaster(ed)?( \d{4})?|radio edit|single version|album version|mono version|stereo version|live|acoustic).*/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSameSong(a, b) {
  if (a.id === b.id) return true;
  if (normalizeTitle(a.name) !== normalizeTitle(b.name)) return false;
  return a.artists.some((x) => b.artists.some((y) => x.id === y.id));
}

async function submitGuess() {
  if (gameOver) return;
  let guess = selectedGuess;
  if (!guess) {
    const q = guessInput.value.trim();
    if (!q) return;
    const results = await searchTracks(q);
    guess = results[0];
    if (!guess) {
      gameStatus.textContent = "Kein Treffer gefunden.";
      return;
    }
  }
  const correct = isSameSong(guess, answer);
  registerAttempt(correct, `${guess.name} — ${guess.artists.map((a) => a.name).join(", ")}`);
}

function skip() {
  if (gameOver) return;

  // Capture exactly how far we'd gotten, then re-anchor the running clock so
  // liveRevealedMs() keeps counting from here — the stream itself is never
  // paused or restarted, so audio flows straight through the skip.
  const wasPlaying = isPlaying;
  if (wasPlaying) {
    revealedMs = liveRevealedMs();
    playBaseMs = revealedMs;
    segmentStartPerf = performance.now();
  }

  const continues = registerAttempt(false, null, true);
  if (!continues) {
    if (wasPlaying) haltPlayback();
    return;
  }

  if (wasPlaying) {
    scheduleAutoStop(segmentToken); // same stream, just pushes the auto-pause further out
  } else {
    continueFromLastStop(); // plays only the newly added slice, once
  }
}

function registerAttempt(correct, label, skipped = false) {
  history[attempt] = correct
    ? { type: "correct", label }
    : skipped
    ? { type: "skip", label: "Skip" }
    : { type: "wrong", label };

  if (correct) {
    endGame(true);
    return false;
  }
  attempt++;
  if (attempt >= MAX_ATTEMPTS) {
    endGame(false);
    return false;
  }
  guessInput.value = "";
  selectedGuess = null;
  renderAttempts();
  gameStatus.textContent = `Versuch ${attempt + 1} von ${MAX_ATTEMPTS} — nächster Clip: ${SNIPPETS_MS[attempt] / 1000}s`;
  return true;
}

function endGame(won) {
  gameOver = true;
  haltPlayback();
  renderAttempts();
  guessInput.disabled = true;
  btnSubmit.disabled = true;
  btnSkip.disabled = true;
  guessSuggestions.classList.add("hidden");

  const img = answer.album.images[Math.min(1, answer.album.images.length - 1)];
  revealArt.src = img ? img.url : "";
  revealTitle.textContent = answer.name;
  revealArtist.textContent = answer.artists.map((a) => a.name).join(", ");
  revealOpen.href = `https://open.spotify.com/track/${answer.id}`;

  if (won) {
    revealResult.textContent = `Erraten — ${attempt + 1}/${MAX_ATTEMPTS}`;
    revealResult.className = "reveal-result win";
    gameStatus.textContent = "Richtig!";
  } else {
    revealResult.textContent = "Nicht erraten";
    revealResult.className = "reveal-result lose";
    gameStatus.textContent = "Diesmal nicht — nächste Runde?";
  }
  reveal.classList.remove("hidden");
}

btnFull.addEventListener("click", async () => {
  await playFrom(answer.uri, 0).catch(() => {});
  gameStatus.textContent = "Voller Song läuft in Spotify.";
});

btnCopy.addEventListener("click", () => {
  const squares = { correct: "🟩", wrong: "🟥", skip: "⬛" };
  const line = history.map((h) => squares[h.type]).join("");
  const result = history[history.length - 1]?.type === "correct"
    ? `${history.length}/${MAX_ATTEMPTS}`
    : "X/6";
  const text = `Needle Drop ${result}\n${line}`;
  navigator.clipboard.writeText(text).then(() => {
    btnCopy.textContent = "Kopiert!";
    setTimeout(() => (btnCopy.textContent = "Ergebnis kopieren"), 1500);
  });
});

btnNext.addEventListener("click", newRound);
btnPlay.addEventListener("click", startPlayback);
btnSubmit.addEventListener("click", submitGuess);
btnSkip.addEventListener("click", skip);

btnPool.addEventListener("click", async () => {
  const q = playlistInput.value.trim();
  const ok = q ? await loadSearchPool(q) : await loadLikedSongs();
  if (ok) newRound();
});

volumeSlider.value = getSavedVolume();
volumeSlider.addEventListener("input", () => {
  const value = Number(volumeSlider.value);
  localStorage.setItem("nd_volume", String(value));
  player?.setVolume(value / 100).catch(() => {});
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
btnLogin.addEventListener("click", startLogin);

async function boot() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  if (code) {
    try {
      await exchangeCode(code);
      window.history.replaceState({}, "", REDIRECT_URI);
    } catch (e) {
      showLoginError("Anmeldung fehlgeschlagen: " + e.message);
    }
  }

  const token = await getValidToken();
  if (!token) {
    screenLogin.classList.remove("hidden");
    screenGame.classList.add("hidden");
    return;
  }

  screenLogin.classList.add("hidden");
  screenGame.classList.remove("hidden");
  accountPill.classList.remove("hidden");
  initPlayer();

  try {
    const res = await api("/me");
    if (res.ok) {
      const me = await res.json();
      accountName.textContent = me.display_name || me.id;
    }
  } catch (_) {}

  gameStatus.textContent = "Verbinde mit Wiedergabegerät …";
  const ok = await loadLikedSongs();
  if (ok) newRound();
}

boot();
