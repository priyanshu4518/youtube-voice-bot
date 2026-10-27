// The assistant window (opened by background.js). It is bound to one YouTube tab, follows that
// tab to new videos, and keeps a chat history per video in chrome.storage.local.
const API = "http://localhost:8000";
const $ = (id) => document.getElementById(id);
const WATCH_URL = /^https:\/\/(www\.|m\.)?youtube\.com\/watch/;
const TIMESTAMP = /^\[(\d+(?::\d{2}){1,2})\]$/;
const HISTORY_LIMIT = 60;
const SPEAK_LIMIT = 5000; // matches SpeakReq.text max_length in the backend
const DEFAULTS = { theme: "system", textSize: "m", autoSpeak: false, voiceAutoSend: false, voiceRate: 1, snap: true };

let settings = { ...DEFAULTS };
let tabId = Number(new URLSearchParams(location.search).get("tab")) || null;
const video = { id: null, title: "", channel: "", time: 0, duration: null, paused: true, ad: false };
let ready = false, loadToken = 0, ticking = false, idleReason = null;
let chunks = [], rows = [], reachedCount = -1, currentRow = -1;
let messages = [], askCtl = null;

// ---------- Helpers ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function toSeconds(str) {
  return str.split(":").reduce((a, n) => a * 60 + Number(n), 0);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function showError(msg) {
  $("error").textContent = msg || "";
  $("error").hidden = !msg;
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

function setStatus(text, state) {
  const s = $("status");
  s.textContent = text;
  s.className = "status " + state;
  s.disabled = state !== "error";
  s.title = state === "error" ? "Click to retry" : "";
}

// ---------- Backend ----------

// POSTs JSON; returns the raw Response, or throws with the backend's error detail.
async function request(path, body, signal) {
  let res;
  try {
    res = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("Cannot reach backend at " + API + ". Is it running?");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.detail === "string" ? data.detail : "Request failed (" + res.status + ")");
  }
  return res;
}

async function post(path, body) {
  const res = await request(path, body);
  return res.json().catch(() => ({}));
}

// Reads /ask/stream (one JSON event per line): onSources gets the transcript excerpts used,
// onText gets the answer so far as the model generates it. Returns the full answer.
async function askStream(body, { onSources, onText }, signal) {
  const res = await request("/ask/stream", body, signal);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", answer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = (buf += value).split("\n");
    buf = lines.pop(); // keep a partial line for the next read
    for (const line of lines) {
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "sources") onSources(ev.sources);
      else if (ev.type === "delta") onText((answer += ev.text));
      else if (ev.type === "error") throw new Error(ev.detail);
    }
  }
  return answer;
}

// ---------- The YouTube tab ----------

// Runs inside the YouTube page.
function readPage() {
  const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
  const title = document.querySelector("ytd-watch-metadata h1")?.textContent.trim()
    || document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");
  const channel = document.querySelector("ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a")?.textContent.trim() || "";
  return {
    videoId: new URL(location.href).searchParams.get("v"),
    currentTime: v ? v.currentTime : null,
    duration: v && isFinite(v.duration) ? v.duration : null,
    paused: v ? v.paused : true,
    ad: !!document.querySelector(".html5-video-player.ad-showing"),
    title,
    channel,
  };
}

// Runs inside the YouTube page.
function controlPage(action, arg) {
  const v = document.querySelector("video.html5-main-video") || document.querySelector("video");
  if (!v) return;
  if (action === "toggle") {
    const btn = document.querySelector(".ytp-play-button");
    btn ? btn.click() : v.paused ? v.play() : v.pause();
  } else if (action === "seek") {
    v.currentTime = arg;
  } else if (action === "skip") {
    v.currentTime = Math.max(0, v.currentTime + arg);
  }
}

async function control(action, arg) {
  if (tabId == null || !video.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: controlPage, args: [action, arg ?? null] });
  } catch {
    return toast("Couldn't reach the video tab");
  }
  tick();
}

const seek = (sec) => control("seek", sec);

function setIdle(reason) {
  if (idleReason === reason) return;
  idleReason = reason;
  if (video.id) resetVideo();
  setStatus("No video", "idle");
  $("video-title").textContent = "Waiting for a video…";
  $("video-channel").textContent = reason;
  $("thumb").hidden = true;
  $("live-badge").hidden = true;
  $("progress-fill").style.width = "0";
  $("time-label").textContent = "0:00";
  for (const b of ["back10", "playpause", "fwd10"]) $(b).disabled = true;
}

function resetVideo() {
  loadToken++;
  stopAsking();
  stopSpeech();
  stopListening(true);
  showError("");
  Object.assign(video, { id: null, title: "", channel: "", time: 0, duration: null });
  chunks = [];
  messages = [];
  setReady(false);
  buildTranscript();
  renderThread();
}

// Polls the bound tab once a second for the video id, position and play state.
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (tabId == null) return setIdle("Open a YouTube video, then click the extension icon.");
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return setIdle("The video tab was closed. Click the extension icon on another video.");
    }
    if (!tab.url || !WATCH_URL.test(tab.url)) return setIdle("Open a YouTube video in the linked tab.");
    let info;
    try {
      [{ result: info }] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
    } catch {
      return; // page still loading
    }
    if (!info?.videoId) return;
    idleReason = null;
    if (info.videoId !== video.id) loadVideo(info.videoId);
    updateVideo(info);
  } finally {
    ticking = false;
  }
}

function updateVideo(info) {
  if (info.title && info.title !== video.title) $("video-title").textContent = video.title = info.title;
  if (info.channel !== video.channel) $("video-channel").textContent = video.channel = info.channel;
  video.ad = info.ad;
  $("live-badge").hidden = !info.ad;
  // During an ad the <video> reports the ad's position, so keep the last real one.
  if (!info.ad && info.currentTime != null) {
    video.time = info.currentTime;
    video.duration = info.duration;
    video.paused = info.paused;
  }
  const pct = video.duration ? Math.min(100, (video.time / video.duration) * 100) : 0;
  $("progress-fill").style.width = pct + "%";
  $("time-label").textContent = fmt(video.time) + (video.duration ? " / " + fmt(video.duration) : "");
  $("playpause").classList.toggle("playing", !video.paused);
  for (const b of ["back10", "playpause", "fwd10"]) $(b).disabled = false;
  updateTranscript();
}

async function loadVideo(id) {
  resetVideo();
  const token = loadToken;
  video.id = id;
  $("thumb").src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  $("thumb").hidden = false;
  messages = await loadHistory(id);
  if (token !== loadToken) return;
  renderThread();
  setStatus("Preparing transcript…", "loading");
  try {
    const t = await post("/transcript", { video_id: id });
    if (token !== loadToken) return;
    chunks = t.chunks || [];
    buildTranscript();
    setStatus("Ready · " + chunks.length + " segments", "ready");
    setReady(true);
    $("question").focus();
  } catch (e) {
    if (token !== loadToken) return;
    setStatus("Unavailable · retry", "error");
    showError(e.message);
  }
}

function setReady(on) {
  ready = on;
  $("question").disabled = $("mic").disabled = !on;
  document.querySelectorAll(".suggestion").forEach((b) => (b.disabled = !on));
  updateSend();
  updateChatActions();
}

$("status").onclick = () => {
  if (!video.id) return;
  showError("");
  const id = video.id;
  video.id = null;
  loadVideo(id);
};

$("playpause").onclick = () => control("toggle");
$("back10").onclick = () => control("skip", -10);
$("fwd10").onclick = () => control("skip", 10);
$("progress").onclick = (e) => {
  if (!video.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  seek(((e.clientX - r.left) / r.width) * video.duration);
};

// background.js sends this when the icon is clicked on another tab while we're open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "bind" || msg.tabId === tabId) return;
  tabId = msg.tabId;
  idleReason = null;
  tick();
});
chrome.tabs.onRemoved.addListener((id) => id === tabId && tick());

// ---------- Answer rendering ----------

function timeLink(sec, label) {
  const a = el("a", "ts", label ?? fmt(sec));
  a.title = "Jump to " + fmt(sec);
  a.onclick = () => seek(sec);
  return a;
}

const INLINE = /(\[\d+(?::\d{2}){1,2}\]|\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/;

function renderInline(parent, text) {
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    const ts = part.match(TIMESTAMP);
    if (ts) parent.append(timeLink(toSeconds(ts[1]), ts[1]));
    else if (/^\*\*.+\*\*$/.test(part)) renderInline(parent.appendChild(el("strong")), part.slice(2, -2));
    else if (/^`.+`$/.test(part)) parent.append(el("code", null, part.slice(1, -1)));
    else if (/^\*.+\*$/.test(part)) renderInline(parent.appendChild(el("em")), part.slice(1, -1));
    else parent.append(part);
  }
}

// A small, safe Markdown subset (paragraphs, lists, headings, bold, italics, code) built
// with DOM nodes, so model output never becomes HTML.
function renderMarkdown(box, text) {
  box.textContent = "";
  let list = null, para = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      list = para = null;
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const head = line.match(/^#{1,6}\s+(.*)$/);
    if (bullet || num) {
      const tag = bullet ? "UL" : "OL";
      if (!list || list.tagName !== tag) {
        list = box.appendChild(el(tag.toLowerCase()));
        if (num) list.start = Number(num[1]);
      }
      para = null;
      renderInline(list.appendChild(el("li")), bullet ? bullet[1] : num[2]);
      continue;
    }
    list = null;
    if (head) {
      para = null;
      renderInline(box.appendChild(el("h4")), head[1]);
      continue;
    }
    if (para) para.append(el("br"));
    else para = box.appendChild(el("p"));
    renderInline(para, line);
  }
}

// ---------- Chat thread ----------

function historyKey(id) {
  return "chat:" + id;
}

async function loadHistory(id) {
  const key = historyKey(id);
  return (await chrome.storage.local.get(key))[key] || [];
}

function saveHistory() {
  if (!video.id) return;
  const done = messages.filter((m) => !m.pending).slice(-HISTORY_LIMIT);
  const key = historyKey(video.id);
  return done.length ? chrome.storage.local.set({ [key]: done }) : chrome.storage.local.remove(key);
}

function nearBottom() {
  const t = $("thread");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function scrollToBottom() {
  const t = $("thread");
  t.scrollTop = t.scrollHeight;
}

function renderThread() {
  const thread = $("thread");
  thread.querySelectorAll(".msg").forEach((n) => n.remove());
  $("empty").hidden = messages.length > 0;
  for (const m of messages) thread.append(m.role === "user" ? userNode(m) : assistantNode(m));
  updateChatActions();
  thread.style.scrollBehavior = "auto";
  scrollToBottom();
  thread.style.scrollBehavior = "";
}

function userNode(m) {
  const node = el("div", "msg user");
  node.dataset.id = m.id;
  node.append(el("div", "bubble", m.text));
  const meta = node.appendChild(el("div", "meta"));
  const at = meta.appendChild(el("button", "at", "asked at " + fmt(m.at)));
  at.type = "button";
  at.onclick = () => seek(m.at);
  return node;
}

function assistantNode(m) {
  const node = $("tpl-assistant").content.firstElementChild.cloneNode(true);
  node.dataset.id = m.id;
  node.querySelector(".at").textContent = "answered at " + fmt(m.at);
  node.querySelector(".at").onclick = () => seek(m.at);
  node.querySelector(".speak").onclick = () => (speech.id === m.id ? stopSpeech() : speak(m));
  node.querySelector(".copy").onclick = () => copyAnswer(m);
  node.querySelector(".retry").onclick = () => retry(m);
  node.querySelector(".sources-btn").onclick = (e) => {
    const list = node.querySelector(".sources");
    list.hidden = !list.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!list.hidden));
  };
  updateAssistantNode(node, m);
  return node;
}

function updateAssistantNode(node, m) {
  node.classList.toggle("pending", !!m.pending && !m.text);
  node.classList.toggle("streaming", !!m.pending && !!m.text);
  node.classList.toggle("error", !!m.error);
  const content = node.querySelector(".content");
  if (m.error) {
    content.textContent = m.error;
  } else {
    renderMarkdown(content, m.text);
    if (m.stopped) content.append(el("span", "stopped", "Stopped"));
  }
  const srcBtn = node.querySelector(".sources-btn");
  srcBtn.hidden = !m.sources?.length;
  srcBtn.querySelector(".label").textContent = "Sources" + (m.sources?.length ? ` (${m.sources.length})` : "");
  const list = node.querySelector(".sources");
  list.textContent = "";
  for (const s of m.sources || []) {
    const li = list.appendChild(el("li"));
    li.append(timeLink(s.start), el("span", null, s.text));
  }
  const btn = node.querySelector(".speak");
  btn.dataset.state = speech.id === m.id ? speech.state : "idle";
  btn.querySelector(".label").textContent = SPEAK_LABELS[btn.dataset.state];
}

function nodeFor(m) {
  return $("thread").querySelector(`.msg[data-id="${m.id}"]`);
}

function refresh(m) {
  const node = nodeFor(m);
  if (node) updateAssistantNode(node, m);
}

function updateChatActions() {
  const has = messages.some((m) => !m.pending);
  $("export-btn").disabled = $("clear-btn").disabled = !has;
}

function updateSend() {
  const busy = !!askCtl;
  const send = $("send");
  send.classList.toggle("busy", busy);
  send.title = busy ? "Stop generating" : "Ask";
  send.setAttribute("aria-label", send.title);
  send.disabled = !busy && (!ready || !$("question").value.trim());
}

function stopAsking() {
  if (askCtl) askCtl.abort();
}

// Asks the backend. `existing` re-uses an assistant message (Retry); `at` pins the video time.
async function ask(question, { existing, at } = {}) {
  if (!ready || askCtl) return;
  showError("");
  stopSpeech();
  const time = at ?? video.time;
  const token = loadToken;
  const ctl = (askCtl = new AbortController());
  updateSend();

  let m = existing;
  const stick = nearBottom();
  if (m) {
    Object.assign(m, { text: "", sources: [], error: null, stopped: false, pending: true });
    refresh(m);
  } else {
    const user = { id: uid(), role: "user", text: question, at: time };
    m = { id: uid(), role: "assistant", question, text: "", sources: [], at: time, pending: true };
    messages.push(user, m);
    $("empty").hidden = true;
    $("thread").append(userNode(user), assistantNode(m));
    scrollToBottom();
  }

  try {
    const answer = await askStream({ video_id: video.id, question, current_time: time }, {
      onSources: (sources) => (m.sources = sources),
      onText: (text) => {
        const follow = nearBottom();
        m.text = text;
        refresh(m);
        if (follow) scrollToBottom();
      },
    }, ctl.signal);
    m.text = answer.trim();
  } catch (err) {
    if (err.name === "AbortError") {
      m.stopped = true;
      if (!m.text) m.error = "Stopped before an answer arrived.";
    } else {
      m.error = err.message || "Something went wrong.";
      m.text = "";
    }
  } finally {
    askCtl = null;
    m.pending = false;
    updateSend();
  }
  if (token !== loadToken) return; // the video changed meanwhile
  refresh(m);
  if (stick || existing == null) scrollToBottom();
  updateChatActions();
  saveHistory();
  if (settings.autoSpeak && m.text && !m.error && !m.stopped) speak(m);
}

function retry(m) {
  if (askCtl) return;
  ask(m.question, { existing: m, at: m.at });
}

async function copyAnswer(m) {
  try {
    await navigator.clipboard.writeText(m.text);
    toast("Answer copied");
  } catch {
    toast("Couldn't copy to the clipboard");
  }
}

$("form").onsubmit = (e) => {
  e.preventDefault();
  if (askCtl) return stopAsking();
  const q = $("question").value.trim();
  if (!q) return;
  stopListening(true); // submit exactly what's in the box now
  $("question").value = "";
  autoGrow();
  ask(q);
};

function autoGrow() {
  const q = $("question");
  q.style.height = "auto";
  q.style.height = Math.min(q.scrollHeight, 180) + "px";
  updateSend();
}

$("question").addEventListener("input", autoGrow);
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("form").requestSubmit();
  }
});

document.querySelectorAll(".suggestion").forEach((b) => (b.onclick = () => ask(b.dataset.q)));

$("clear-btn").onclick = () => {
  if (!confirm("Clear the chat for this video?")) return;
  stopAsking();
  stopSpeech();
  messages = [];
  saveHistory();
  renderThread();
  toast("Chat cleared");
};

$("export-btn").onclick = () => {
  const lines = [`# ${video.title || "YouTube video"}`, "", `https://www.youtube.com/watch?v=${video.id}`, ""];
  for (const m of messages) {
    if (m.pending) continue;
    if (m.role === "user") lines.push(`**You** (at ${fmt(m.at)}): ${m.text}`, "");
    else lines.push(`**Assistant:** ${m.error ? "_" + m.error + "_" : m.text}`, "", "---", "");
  }
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
  const a = el("a");
  a.href = url;
  a.download = `${(video.title || video.id).replace(/[\\/:*?"<>|]+/g, "").slice(0, 80)} - chat.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ---------- Transcript ----------

function buildTranscript() {
  const list = $("tr-list");
  list.textContent = "";
  rows = chunks.map((c) => {
    const row = el("div", "tr-row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.append(el("span", "chip", fmt(c.start)), el("span", "text", c.text));
    const askBtn = row.appendChild(el("button", "ask", "Ask"));
    askBtn.type = "button";
    askBtn.title = "Ask about this part";
    askBtn.onclick = (e) => {
      e.stopPropagation();
      const snippet = c.text.length > 120 ? c.text.slice(0, 120).trimEnd() + "…" : c.text;
      $("question").value = `Explain what is meant at [${fmt(c.start)}]: "${snippet}"`;
      showView("chat");
      autoGrow();
      $("question").focus();
    };
    row.onclick = () => seek(c.start);
    row.onkeydown = (e) => e.key === "Enter" && seek(c.start);
    list.append(row);
    return row;
  });
  reachedCount = currentRow = -1;
  $("tr-empty").hidden = chunks.length > 0;
  updateTranscript();
}

// Shows only what has been said up to the current position (no spoilers), filtered by the search.
function updateTranscript(force) {
  let n = 0;
  while (n < chunks.length && chunks[n].start <= video.time) n++;
  const cur = n - 1;
  if (!force && n === reachedCount && cur === currentRow) return;
  const grew = n !== reachedCount;
  reachedCount = n;
  if (rows[currentRow]) rows[currentRow].classList.remove("current");
  currentRow = cur;
  if (rows[cur]) rows[cur].classList.add("current");

  const q = $("tr-search").value.trim().toLowerCase();
  if (grew || force) {
    rows.forEach((row, i) => {
      const text = chunks[i].text;
      const match = !q || text.toLowerCase().includes(q);
      row.hidden = i >= n || !match;
      highlight(row.querySelector(".text"), text, q);
    });
  }
  const locked = chunks.length - n;
  $("tr-locked").hidden = !chunks.length || locked === 0;
  $("tr-locked-text").textContent = `${locked} more segment${locked === 1 ? "" : "s"} unlock as you watch`;
  $("tr-count").textContent = chunks.length ? String(n) : "";

  const visible = $("view-transcript").classList.contains("active");
  if (visible && !q && $("tr-follow").checked && rows[cur]) rows[cur].scrollIntoView({ block: "center", behavior: "smooth" });
}

function highlight(node, text, q) {
  if (!q) {
    if (node.childElementCount) node.textContent = text;
    return;
  }
  node.textContent = "";
  const lower = text.toLowerCase();
  let i = 0;
  for (let j; (j = lower.indexOf(q, i)) !== -1; i = j + q.length) {
    node.append(text.slice(i, j), el("mark", null, text.slice(j, j + q.length)));
  }
  node.append(text.slice(i));
}

$("tr-search").addEventListener("input", () => updateTranscript(true));
$("tr-follow").addEventListener("change", () => updateTranscript(true));

// ---------- Tabs ----------

function showView(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  $("chat-actions").hidden = name !== "chat";
  if (name === "transcript") updateTranscript(true);
}

document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showView(t.dataset.view)));

// ---------- Speech output ----------

const SPEAK_LABELS = { idle: "Listen", loading: "Loading…", playing: "Stop" };
const speech = { id: null, state: "idle", ctl: null, url: null };

function setSpeech(id, state) {
  const prev = speech.id;
  speech.id = id;
  speech.state = state;
  for (const mid of new Set([prev, id])) {
    const m = messages.find((x) => x.id === mid);
    if (m) refresh(m);
  }
  const bar = $("now-speaking");
  bar.hidden = state === "idle";
  bar.classList.toggle("loading", state === "loading");
  $("ns-label").textContent = state === "loading" ? "Generating audio…" : "Reading the answer aloud";
  if (state !== "playing") $("ns-time").textContent = "";
}

// Cancels any in-flight speech request, stops playback and frees the audio blob.
function stopSpeech() {
  if (speech.ctl) speech.ctl.abort();
  speech.ctl = null;
  const p = $("player");
  p.pause();
  p.removeAttribute("src");
  p.load();
  if (speech.url) URL.revokeObjectURL(speech.url);
  speech.url = null;
  if (speech.id) setSpeech(null, "idle");
}

// Resolves when `type` fires on `target`; rejects with AbortError if the speech request is cancelled first.
function once(target, type, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    target.addEventListener(type, () => { signal.removeEventListener("abort", onAbort); resolve(); }, { once: true });
  });
}

function startPlayback(p, id) {
  p.playbackRate = Number(settings.voiceRate) || 1;
  setSpeech(id, "playing");
  return p.play().catch((e) => {
    if (e.name === "NotAllowedError") showError("Chrome blocked autoplay. Click Listen to play the answer.");
    else if (e.name !== "AbortError") throw e;
  });
}

// Plays the MP3 while it is still downloading (MediaSource), so audio starts as soon as the
// backend streams the first bytes instead of after the whole clip is synthesized.
async function playStream(res, p, id, signal) {
  const ms = new MediaSource();
  speech.url = URL.createObjectURL(ms);
  p.src = speech.url;
  await once(ms, "sourceopen", signal);
  const sb = ms.addSourceBuffer("audio/mpeg");
  const reader = res.body.getReader();
  let started = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sb.appendBuffer(value);
    await once(sb, "updateend", signal);
    if (!started) {
      started = true;
      startPlayback(p, id).catch(() => {
        stopSpeech(); // aborts this download too
        showError("Could not play the generated audio.");
      });
    }
  }
  if (!started) throw new Error("The backend returned no audio.");
  ms.endOfStream();
}

async function speak(m) {
  stopSpeech(); // never let two clips overlap
  if (!m.text.trim()) return;
  stopListening(true); // don't transcribe our own playback
  showError("");
  const ctl = (speech.ctl = new AbortController());
  setSpeech(m.id, "loading");
  try {
    const res = await request("/speak", { text: m.text.slice(0, SPEAK_LIMIT) }, ctl.signal);
    const p = $("player");
    if (res.body && window.MediaSource && MediaSource.isTypeSupported("audio/mpeg")) {
      await playStream(res, p, m.id, ctl.signal);
    } else {
      const blob = await res.blob();
      if (!blob.size) throw new Error("The backend returned no audio.");
      speech.url = URL.createObjectURL(blob);
      p.src = speech.url;
      await startPlayback(p, m.id);
    }
  } catch (err) {
    if (err.name === "AbortError" || ctl.signal.aborted) return;
    stopSpeech();
    showError(err.message || "Could not play the generated audio.");
  } finally {
    if (speech.ctl === ctl) speech.ctl = null;
  }
}

$("player").onended = stopSpeech;
$("player").onerror = () => {
  if (!speech.url) return; // error from clearing src during stopSpeech
  stopSpeech();
  showError("Could not play the generated audio.");
};
$("player").ontimeupdate = () => {
  if (speech.state === "playing") $("ns-time").textContent = fmt($("player").currentTime);
};
$("player").onplay = $("player").onpause = () => {
  const paused = $("player").paused && speech.state === "playing";
  $("ns-toggle").classList.toggle("paused", paused);
  $("ns-toggle").title = paused ? "Resume" : "Pause";
  $("now-speaking").classList.toggle("paused", paused);
};
$("ns-toggle").onclick = () => {
  const p = $("player");
  if (speech.state !== "playing") return;
  p.paused ? p.play().catch(() => {}) : p.pause();
};
$("ns-stop").onclick = stopSpeech;
window.addEventListener("pagehide", stopSpeech);

// ---------- Voice input ----------

// Uses the browser's built-in Web Speech API: free, no API key.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_ERRORS = {
  "no-speech": "Didn't hear anything. Click the mic and try again.",
  "audio-capture": "No microphone found. Connect one and try again.",
  network: "Voice input needs an internet connection (Chrome sends audio to its speech service).",
  "language-not-supported": "Voice input doesn't support your browser's language.",
  "service-not-allowed": "Chrome's speech service is unavailable. Type your question instead.",
  "not-allowed": "Microphone access is blocked. Allow it for this extension at chrome://settings/content/microphone.",
};
let recognition = null;

function setListening(on) {
  const mic = $("mic");
  mic.classList.toggle("listening", on);
  mic.setAttribute("aria-pressed", String(on));
  mic.setAttribute("aria-label", on ? "Stop listening" : "Ask by voice");
  mic.title = on ? "Stop listening" : "Ask by voice";
  $("form").classList.toggle("listening", on);
  $("question").readOnly = on; // typing would be overwritten by live results
  $("question").placeholder = on ? "Listening…" : "Ask about the video so far…";
}

// stop() keeps what was heard so far; abort() discards the pending result.
function stopListening(discard) {
  if (!recognition) return;
  discard ? recognition.abort() : recognition.stop();
}

// This is a normal window (not a popup), so Chrome can show its mic prompt right here.
async function ensureMic() {
  try {
    if ((await navigator.permissions.query({ name: "microphone" })).state === "granted") return true;
  } catch {
    // permissions.query unsupported: fall through to getUserMedia
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // we only needed the grant, not the audio
    return true;
  } catch (e) {
    showError(e.name === "NotFoundError" ? MIC_ERRORS["audio-capture"] : MIC_ERRORS["not-allowed"]);
    return false;
  }
}

async function startListening() {
  if (!SpeechRecognition) return showError("Voice input isn't supported in this browser. Try Chrome, or type your question.");
  showError("");
  if (!(await ensureMic())) return;
  stopSpeech(); // don't transcribe our own TTS playback

  const rec = new SpeechRecognition();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false; // ends on its own after a pause
  const base = $("question").value.trim(); // dictation appends to anything already typed
  let heardAny = false, failed = false;

  rec.onresult = (e) => {
    const heard = Array.from(e.results, (r) => r[0].transcript).join("").trim();
    heardAny = heardAny || !!heard;
    $("question").value = [base, heard].filter(Boolean).join(" ");
    autoGrow();
  };
  rec.onerror = (e) => {
    if (e.error === "aborted") return;
    failed = true;
    showError(MIC_ERRORS[e.error] || "Voice input failed (" + e.error + "). Try again or type your question.");
  };
  rec.onend = () => {
    if (recognition !== rec) return;
    recognition = null;
    setListening(false);
    const q = $("question");
    q.value = q.value.trim();
    autoGrow();
    if (settings.voiceAutoSend && heardAny && !failed && q.value) return $("form").requestSubmit();
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  };

  recognition = rec;
  setListening(true);
  try {
    rec.start();
  } catch (err) {
    recognition = null;
    setListening(false);
    showError("Could not start voice input: " + err.message);
  }
}

$("mic").onclick = () => (recognition ? stopListening(false) : startListening());
window.addEventListener("pagehide", () => stopListening(true));

// ---------- Settings ----------

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  root.dataset.size = settings.textSize;
  $("player").playbackRate = Number(settings.voiceRate) || 1;
  $("snap-btn").setAttribute("aria-pressed", String(settings.snap));
  document.querySelectorAll(".segmented").forEach((seg) => {
    seg.querySelectorAll("button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.value === String(settings[seg.dataset.setting]))));
  });
  document.querySelectorAll('input[type="checkbox"][data-setting]').forEach((c) => (c.checked = !!settings[c.dataset.setting]));
}

async function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  applySettings();
  await chrome.storage.local.set({ settings });
  if (key === "snap" && tabId != null) {
    const res = await chrome.runtime.sendMessage({ type: "snap", on: value, tabId }).catch(() => null);
    if (res && !res.ok) toast("Couldn't rearrange the windows");
  }
}

document.querySelectorAll(".segmented").forEach((seg) => {
  seg.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.value;
      setSetting(seg.dataset.setting, seg.dataset.setting === "voiceRate" ? Number(v) : v);
    };
  });
});
document.querySelectorAll('input[type="checkbox"][data-setting]').forEach((c) => {
  c.onchange = () => setSetting(c.dataset.setting, c.checked);
});

$("settings-btn").onclick = () => $("settings").showModal();
$("settings").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close(); // backdrop click
});
$("snap-btn").onclick = () => setSetting("snap", !settings.snap);

$("clear-all").onclick = async () => {
  if (!confirm("Delete the saved chats for every video?")) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("chat:")));
  stopAsking();
  stopSpeech();
  messages = [];
  renderThread();
  $("settings").close();
  toast("All chats cleared");
};

// ---------- Keyboard ----------

document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea");
  if (e.key === "/" && !typing && !$("settings").open) {
    e.preventDefault();
    showView("chat");
    $("question").focus();
  } else if (e.key === "Escape" && !$("settings").open) {
    if (askCtl) stopAsking();
    else if (recognition) stopListening(true);
    else if (speech.id) stopSpeech();
  }
});

// ---------- Start ----------

(async () => {
  const stored = (await chrome.storage.local.get("settings")).settings;
  settings = { ...DEFAULTS, ...stored };
  applySettings();
  await tick();
  setInterval(() => document.visibilityState === "visible" && tick(), 1000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && tick());
})();
