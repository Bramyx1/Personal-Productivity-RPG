'use strict';

const STORAGE_KEYS = {
  SETTINGS: 'settings'
};

const rpgUrlEl = document.getElementById('rpgUrl');
const statusEl = document.getElementById('status');

document.getElementById('saveBtn').addEventListener('click', onSave);

init().catch((error) => setStatus(`Init failed: ${error.message}`));

async function init() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = data[STORAGE_KEYS.SETTINGS] || {};
  rpgUrlEl.value = settings.rpgUrl || '';
}

async function onSave() {
  const rpgUrl = rpgUrlEl.value.trim();

  if (rpgUrl && !isValidUrl(rpgUrl)) {
    setStatus('Please enter a valid URL (https://...).');
    return;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: {
      rpgUrl
    }
  });

  setStatus('Options saved.');
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}
