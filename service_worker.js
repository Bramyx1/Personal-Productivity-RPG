'use strict';

const STORAGE_KEYS = {
  SETTINGS: 'settings',
  RESULTS: 'scanResults',
  PENDING_SYNC: 'pendingSync'
};

const DEFAULT_SETTINGS = {
  rpgUrl: 'https://bramyx1.github.io/Personal-Productivity-RPG/'
};

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.RESULTS]);
  if (!data[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  if (!data[STORAGE_KEYS.RESULTS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.RESULTS]: {} });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === 'SYNC_TO_RPG') {
    const tasks = message.payload?.tasks || message.payload?.assignments || [];
    syncToRpg(tasks)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'SYNC_PENDING') {
    handleSyncPending()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'GUIDED_SCAN_ALL_COURSES') {
    handleGuidedScanAllCourses(message.tabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

});

async function handleSyncToRpg(payload) {
  const tasks = payload?.tasks || payload?.assignments || [];
  return syncToRpg(tasks);
}

async function handleSyncPending() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PENDING_SYNC);
  const pending = data[STORAGE_KEYS.PENDING_SYNC];

  if (!pending || !Array.isArray(pending.tasks) || !pending.tasks.length) {
    return { synced: false, pending: false, reason: 'No pending payload' };
  }

  return syncToRpg(pending.tasks);
}

async function handleGuidedScanAllCourses(originTabId) {
  if (!originTabId) {
    throw new Error('No active tab available for guided scan.');
  }

  const scanResponse = await chrome.tabs.sendMessage(originTabId, { type: 'SCAN_PAGE' });
  const scored = (scanResponse?.assignments || []).map(scoreAssignment);
  await upsertScanResults(scored);

  return {
    scanned: 1,
    assignments: scored
  };
}

async function upsertScanResults(assignments) {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.RESULTS);
  const currentMap = existing[STORAGE_KEYS.RESULTS] || {};

  for (const assignment of assignments) {
    const key = assignment.id || `${assignment.title}|${assignment.course}|${assignment.dueAt || ''}`;
    currentMap[key] = assignment;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.RESULTS]: currentMap });
}

function scoreAssignment(assignment) {
  const now = Date.now();
  const dueTime = assignment.dueAt ? Date.parse(assignment.dueAt) : NaN;

  let urgency = 20;
  if (!Number.isNaN(dueTime)) {
    const hours = (dueTime - now) / 36e5;
    if (hours <= 0) {
      urgency = 100;
    } else if (hours <= 24) {
      urgency = 90;
    } else if (hours <= 72) {
      urgency = 75;
    } else if (hours <= 168) {
      urgency = 55;
    } else {
      urgency = 35;
    }
  }

  const difficulty = estimateDifficulty(assignment.title || '');
  const recommendedXp = Math.round(20 + urgency * 0.8 + difficulty * 0.6);

  return {
    ...assignment,
    urgencyScore: Math.min(100, Math.max(0, urgency)),
    recommendedXp
  };
}

function estimateDifficulty(title) {
  const text = title.toLowerCase();
  let points = 10;

  if (text.includes('exam') || text.includes('midterm') || text.includes('final')) points += 45;
  if (text.includes('project')) points += 35;
  if (text.includes('paper') || text.includes('essay')) points += 25;
  if (text.includes('quiz')) points += 15;
  if (text.includes('discussion')) points += 8;

  return Math.min(points, 100);
}

async function syncToRpg(tasks) {
  const rpgUrl = await getRpgUrl();
  const targetTab = await findOpenRpgTab(rpgUrl);
  const taskList = Array.isArray(tasks) ? tasks : [];

  if (!targetTab) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PENDING_SYNC]: {
        tasks: taskList,
        savedAt: new Date().toISOString()
      }
    });
    return { synced: false, pending: true, reason: 'RPG tab not open' };
  }

  const response = await chrome.tabs.sendMessage(targetTab.id, {
    type: 'BB_INTEL_SYNC_V1',
    payload: { tasks: taskList }
  }).catch(() => null);

  if (!response?.ok) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PENDING_SYNC]: {
        tasks: taskList,
        savedAt: new Date().toISOString()
      }
    });
    return { synced: false, pending: true, reason: 'Failed to deliver message to RPG tab' };
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_SYNC]: null });
  return { synced: true, pending: false, tabId: targetTab.id };
}

async function getRpgUrl() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const configured = data.settings?.rpgUrl?.trim();
  return configured || DEFAULT_SETTINGS.rpgUrl;
}

async function findOpenRpgTab(rpgUrl) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(rpgUrl)) || null;
}
