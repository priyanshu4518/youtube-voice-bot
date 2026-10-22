// Opened in a tab by the popup: popups can't show Chrome's mic prompt, but a tab can.
// Once granted, the permission applies to the whole extension origin, popup included.
const $ = (id) => document.getElementById(id);

function show(text, state, message, canRetry) {
  $("status").textContent = text;
  $("status").className = "status " + state;
  $("message").textContent = message;
  $("retry").hidden = !canRetry;
}

async function requestMic() {
  show("Waiting for microphone permission…", "loading", "Click Allow in Chrome's prompt.", false);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // we only needed the grant, not the audio
    show("Microphone enabled", "ready",
      "Done! This tab will close. Open the extension again and click the mic button to ask by voice.", false);
    setTimeout(async () => {
      const tab = await chrome.tabs.getCurrent();
      if (tab) chrome.tabs.remove(tab.id);
    }, 2000);
  } catch (e) {
    if (e.name === "NotFoundError") {
      show("No microphone found", "error", "Connect a microphone, then try again.", true);
    } else if (e.name === "NotAllowedError") {
      show("Microphone blocked", "error",
        "Microphone access is blocked for this extension. Click the icon at the right of the address bar " +
        "(or open chrome://settings/content/microphone), allow the microphone for this extension, then try again.", true);
    } else {
      show("Could not access the microphone", "error", e.message || String(e), true);
    }
  }
}

$("retry").onclick = requestMic;
requestMic();
