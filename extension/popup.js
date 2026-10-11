const API = "http://localhost:8000";
const $ = (id) => document.getElementById(id);
let tabId, videoId;

// Runs inside the YouTube page: returns the video id and playback position.
function readPage() {
  const v = document.querySelector("video");
  const id = new URL(location.href).searchParams.get("v");
  return { videoId: id, currentTime: v ? v.currentTime : null };
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Cannot reach backend at " + API + ". Is it running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Request failed (" + res.status + ")");
  return data;
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

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
    if (!tab.url || !tab.url.includes("youtube.com/watch")) throw new Error("Open a YouTube video first.");
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
    videoId = result.videoId;
    setStatus("Preparing transcript…", "loading");
    const t = await post("/transcript", { video_id: videoId });
    setStatus("Ready · " + t.chunks.length + " transcript chunks", "ready");
    $("question").disabled = $("ask").disabled = false;
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
  showError("");
  $("answer").textContent = "";
  $("loader").hidden = false;
  $("ask").disabled = true;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
    if (result.currentTime == null) throw new Error("No video player found on the page.");
    const data = await post("/ask", { video_id: videoId, question, current_time: result.currentTime });
    renderAnswer(data.answer);
    $("hint").hidden = true;
  } catch (err) {
    showError(err.message);
  } finally {
    $("loader").hidden = true;
    $("ask").disabled = false;
  }
};

init();
