console.log("RPG BRIDGE LOADED");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "BB_INTEL_SYNC_V1") return;

  window.postMessage(
    { channel: "BB_INTEL_SYNC_V1", payload: msg.payload },
    window.location.origin
  );

  sendResponse({ ok: true });
});
