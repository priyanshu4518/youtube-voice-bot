// Clicking the toolbar icon opens the assistant in its own window covering the right half of the
// browser window. With "Snap side by side" on, the YouTube window is moved to the left half and
// restored to its old size and position when the assistant closes.
// State lives in chrome.storage.session because the service worker can be stopped at any time.

async function getState() {
  return (await chrome.storage.session.get("panel")).panel || null;
}

function setState(state) {
  return state ? chrome.storage.session.set({ panel: state }) : chrome.storage.session.remove("panel");
}

async function snapEnabled() {
  const { settings } = await chrome.storage.local.get("settings");
  return settings?.snap ?? true;
}

// Puts the browser window `windowId` on the left half of its area and the assistant on the right.
async function tile(windowId) {
  const state = await getState();
  if (!state) return;
  if (state.restore && state.restore.windowId !== windowId) await untile();
  const win = await chrome.windows.get(windowId);
  if (win.state === "fullscreen") return;
  // Split the window's original area, so tiling twice doesn't keep halving it.
  const area = state.restore?.windowId === windowId
    ? state.restore
    : { windowId, state: win.state, left: win.left, top: win.top, width: win.width, height: win.height };
  const half = Math.round(area.width / 2);
  await chrome.windows.update(windowId, { state: "normal", left: area.left, top: area.top, width: half, height: area.height });
  await chrome.windows.update(state.windowId, {
    state: "normal", left: area.left + half, top: area.top, width: area.width - half, height: area.height, focused: true,
  });
  await setState({ ...(await getState()), restore: area });
}

// Gives the YouTube window back the size, position and state it had before tiling.
async function untile() {
  const state = await getState();
  if (!state?.restore) return;
  const { windowId, left, top, width, height } = state.restore;
  await setState({ ...state, restore: null });
  try {
    await chrome.windows.update(windowId, { state: "normal", left, top, width, height });
    if (state.restore.state === "maximized") await chrome.windows.update(windowId, { state: "maximized" });
  } catch {
    // The window was closed.
  }
}

async function openPanel(tab) {
  const win = await chrome.windows.get(tab.windowId);
  const width = Math.max(440, Math.round(win.width / 2));
  const panel = await chrome.windows.create({
    url: "panel.html?tab=" + tab.id,
    type: "popup",
    left: win.left + win.width - width,
    top: win.top,
    width,
    height: win.height,
    focused: true,
  });
  await setState({ windowId: panel.id, restore: null });
  if (await snapEnabled()) await tile(tab.windowId);
}

chrome.action.onClicked.addListener(async (tab) => {
  const state = await getState();
  if (state) {
    try {
      await chrome.windows.update(state.windowId, { focused: true });
      await chrome.runtime.sendMessage({ type: "bind", tabId: tab.id }).catch(() => {});
      if (await snapEnabled()) await tile(tab.windowId);
      return;
    } catch {
      await setState(null); // the assistant window is gone
    }
  }
  await openPanel(tab);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const state = await getState();
  if (state?.windowId !== windowId) return;
  await untile();
  await setState(null);
});

// The panel toggles snapping from its toolbar.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== "snap") return;
  (async () => {
    if (!msg.on) return untile();
    const tab = await chrome.tabs.get(msg.tabId);
    return tile(tab.windowId);
  })().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) }));
  return true; // reply asynchronously
});
