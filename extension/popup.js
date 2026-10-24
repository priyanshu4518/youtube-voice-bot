const API = "http://localhost:8000";
const $ = (id) => document.getElementById(id);
let tabId, tabIndex, videoId;
let answerText = "", speechCtl = null, audioUrl = null;

// Runs inside the YouTube page: returns the video id and playback position.
function readPage() {
  const v = document.querySelector("video");
  const id = new URL(location.href).searchParams.get("v");
  return { videoId: id, currentTime: v ? v.currentTime : null };
}

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

// Reads /ask/stream (one JSON event per line) and calls onText with the answer so far,
// so text appears as the model generates it. Returns the full answer.
async function askStream(body, onText) {
  const res = await request("/ask/stream", body);
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
      if (ev.type === "delta") onText((answer += ev.text));
      else if (ev.type === "error") throw new Error(ev.detail);
    }
  }
  return answer;
}

function showError(msg) {
  $("error").textContent = msg;
  $("error").hidden = !msg;
}

function setStatus(text, state) {
  $("status").textContent = text;
  $("status").className = "status " + state;
}

function toSeconds(str) {
  return str.split(":").reduce((a, n) => a * 60 + Number(n), 0);
}

// Render answer as text; [m:ss] citations become clickable seek links.
function renderAnswer(text) {
  const box = $("answer");
  box.textContent = "";
  text.split(/(\[\d+(?::\d{2}){1,2}\])/).forEach((part) => {
    const m = part.match(/^\[(\d+(?::\d{2}){1,2})\]$/);
    if (!m) return box.append(part);
    const a = document.createElement("a");
    a.textContent = part;
    a.onclick = () =>
      chrome.scripting.executeScript({
        target: { tabId },
        args: [toSeconds(m[1])],
        func: (t) => {
          const v = document.querySelector("video");
          if (v) v.currentTime = t;
        },
      });
    box.append(a);
  });
}

const SPEAK_LABELS = { idle: "Speak answer", loading: "Generating audio…", playing: "Stop" };

function setSpeakState(state) {
  $("speak").dataset.state = state;
  $("speak").disabled = state === "loading";
  $("speak-label").textContent = SPEAK_LABELS[state];
}

// Cancels any in-flight speech request, stops playback and frees the audio blob.
function stopSpeech() {
  if (speechCtl) speechCtl.abort();
  speechCtl = null;
  const p = $("player");
  p.pause();
  p.removeAttribute("src");
  p.load();
  p.hidden = true;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  setSpeakState("idle");
}

// Resolves when `type` fires on `target`; rejects with AbortError if the speech request is cancelled first.
function once(target, type, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    target.addEventListener(type, () => { signal.removeEventListener("abort", onAbort); resolve(); }, { once: true });
  });
}

function startPlayback(p) {
  p.hidden = false;
  setSpeakState("playing");
  // If Chrome blocks autoplay, the visible controls still let the user press play.
  return p.play().catch((e) => { if (e.name !== "NotAllowedError" && e.name !== "AbortError") throw e; });
}

// Plays the MP3 while it is still downloading (MediaSource), so audio starts as soon as the
// backend streams the first bytes instead of after the whole clip is synthesized.
async function playStream(res, p, signal) {
  const ms = new MediaSource();
  audioUrl = URL.createObjectURL(ms);
  p.src = audioUrl;
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
      startPlayback(p).catch(() => {
        stopSpeech(); // aborts this download too
        showError("Could not play the generated audio.");
      });
    }
  }
  if (!started) throw new Error("The backend returned no audio.");
  ms.endOfStream();
}

async function speak() {
  stopSpeech(); // never let two clips overlap
  if (!answerText.trim()) return showError("There is no answer to speak yet.");
  showError("");
  const ctl = (speechCtl = new AbortController());
  setSpeakState("loading");
  try {
    const res = await request("/speak", { text: answerText }, ctl.signal);
    const p = $("player");
    if (res.body && window.MediaSource && MediaSource.isTypeSupported("audio/mpeg")) {
      await playStream(res, p, ctl.signal);
    } else {
      const blob = await res.blob();
      if (!blob.size) throw new Error("The backend returned no audio.");
      audioUrl = URL.createObjectURL(blob);
      p.src = audioUrl;
      await startPlayback(p);
    }
  } catch (err) {
    if (err.name === "AbortError" || ctl.signal.aborted) return;
    stopSpeech();
    showError(err.message || "Could not play the generated audio.");
  } finally {
    if (speechCtl === ctl) speechCtl = null;
  }
}

$("speak").onclick = () => ($("speak").dataset.state === "playing" ? stopSpeech() : speak());
$("player").onended = stopSpeech;
$("player").onerror = () => {
  if (!audioUrl) return; // error from clearing src during stopSpeech
  stopSpeech();
  showError("Could not play the generated audio.");
};
window.addEventListener("pagehide", stopSpeech);

// Voice input uses the browser's built-in Web Speech API: free, no API key.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_ERRORS = {
  "no-speech": "Didn't hear anything. Click the mic and try again.",
  "audio-capture": "No microphone found. Connect one and try again.",
  network: "Voice input needs an internet connection (Chrome sends audio to its speech service).",
  "language-not-supported": "Voice input doesn't support your browser's language.",
  "service-not-allowed": "Chrome's speech service is unavailable. Type your question instead.",
};
let recognition = null;

function setListening(on) {
  const mic = $("mic");
  mic.classList.toggle("listening", on);
  mic.setAttribute("aria-pressed", String(on));
  mic.setAttribute("aria-label", on ? "Stop listening" : "Ask by voice");
  mic.title = on ? "Stop listening" : "Ask by voice";
  $("question").readOnly = on; // typing would be overwritten by live results
  $("question").placeholder = on ? "Listening…" : "Ask about the video so far…";
}

// stop() keeps what was heard so far; abort() discards the pending result.
function stopListening(discard) {
  if (!recognition) return;
  discard ? recognition.abort() : recognition.stop();
}

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch {
    return "unknown";
  }
}

// Popups can't show Chrome's permission prompt, so ask from a regular tab next to the video.
function openPermissionPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("permission.html"), openerTabId: tabId, index: tabIndex + 1 });
}

async function startListening() {
  if (!SpeechRecognition) return showError("Voice input isn't supported in this browser. Try Chrome, or type your question.");
  showError("");
  const perm = await micPermission();
  if (perm === "prompt" || perm === "denied") return openPermissionPage();
  stopSpeech(); // don't transcribe our own TTS playback

  const rec = new SpeechRecognition();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false; // ends on its own after a pause
  const base = $("question").value.trim(); // dictation appends to anything already typed

  rec.onresult = (e) => {
    const heard = Array.from(e.results, (r) => r[0].transcript).join("").trim();
    $("question").value = [base, heard].filter(Boolean).join(" ");
  };
  rec.onerror = (e) => {
    if (e.error === "aborted") return;
    if (e.error === "not-allowed" && perm !== "granted") return openPermissionPage();
    if (e.error === "not-allowed") return showError("Microphone access was blocked. Allow it for this extension in Chrome's site settings.");
    showError(MIC_ERRORS[e.error] || "Voice input failed (" + e.error + "). Try again or type your question.");
  };
  rec.onend = () => {
    if (recognition !== rec) return;
    recognition = null;
    setListening(false);
    const q = $("question");
    q.value = q.value.trim();
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

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
    tabIndex = tab.index;
    if (!tab.url || !tab.url.includes("youtube.com/watch")) throw new Error("Open a YouTube video first.");
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
    videoId = result.videoId;
    setStatus("Preparing transcript…", "loading");
    const t = await post("/transcript", { video_id: videoId });
    setStatus("Ready · " + t.chunks.length + " transcript chunks", "ready");
    $("question").disabled = $("ask").disabled = $("mic").disabled = false;
    $("question").focus();
  } catch (e) {
    setStatus("Unavailable", "error");
    showError(e.message);
  }
}

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const question = $("question").value.trim();
  if (!question) return;
  stopListening(true); // submit exactly what's in the box now
  showError("");
  stopSpeech();
  answerText = "";
  $("speech").hidden = true;
  $("answer").textContent = "";
  $("loader").hidden = false;
  $("ask").disabled = true;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
    if (result.currentTime == null) throw new Error("No video player found on the page.");
    const answer = await askStream({ video_id: videoId, question, current_time: result.currentTime }, (text) => {
      $("loader").hidden = true;
      renderAnswer(text);
    });
    answerText = answer.trim();
    $("speech").hidden = !answerText;
    $("hint").hidden = true;
  } catch (err) {
    showError(err.message);
  } finally {
    $("loader").hidden = true;
    $("ask").disabled = false;
  }
};

init();
