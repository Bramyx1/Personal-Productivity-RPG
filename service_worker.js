'use strict';

const STORAGE_KEYS = {
  SETTINGS: 'settings',
  RESULTS: 'scanResults',
  PENDING_SYNC: 'pendingSync',
  LAST_AUTO_SYNC_AT: 'lastAutoSyncAt'
};

const DEFAULT_SETTINGS = {
  rpgUrl: 'https://bramyx1.github.io/Personal-Productivity-RPG/'
};

const AUTO_SYNC_MIN_INTERVAL_MS = 60 * 1000;
const AUTO_SYNC_SCAN_LIMIT = 12;

let autoSyncInProgress = false;

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.RESULTS]);
  if (!data[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  if (!data[STORAGE_KEYS.RESULTS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.RESULTS]: {} });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!isBlackboardUrl(tab?.url)) return;
  void triggerAutoCollectAndSync(tabId, 'tab-updated');
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
    autoCollectAndSync(message.tabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'AUTO_COLLECT_AND_SYNC') {
    triggerAutoCollectAndSync(message.tabId || sender?.tab?.id || null, 'runtime-message')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function triggerAutoCollectAndSync(originTabId, reason) {
  if (!originTabId) {
    return { triggered: false, reason: 'No origin tab id' };
  }
  if (autoSyncInProgress) {
    return { triggered: false, reason: 'Auto sync already in progress' };
  }

  const data = await chrome.storage.local.get(STORAGE_KEYS.LAST_AUTO_SYNC_AT);
  const lastAutoSyncAt = Number(data[STORAGE_KEYS.LAST_AUTO_SYNC_AT] || 0);
  if (Date.now() - lastAutoSyncAt < AUTO_SYNC_MIN_INTERVAL_MS) {
    return { triggered: false, reason: 'Auto sync cooldown active' };
  }

  autoSyncInProgress = true;
  try {
    const result = await autoCollectAndSync(originTabId);
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AUTO_SYNC_AT]: Date.now() });
    return { triggered: true, reason, ...result };
  } finally {
    autoSyncInProgress = false;
  }
}

async function autoCollectAndSync(originTabId) {
  const originTab = await chrome.tabs.get(originTabId).catch(() => null);
  if (!originTab?.id) {
    throw new Error('No active tab available for auto collect.');
  }

  const urlsToScan = await getUrlsToScan(originTab.id, originTab.url || '');
  const assignments = await scanUrlsFromOriginTab(originTab.id, urlsToScan);
  const scored = assignments.map(scoreAssignment);

  await upsertScanResults(scored);

  const tasks = scored.map(toTask);
  const syncResult = await syncToRpg(tasks);

  return {
    scanned: urlsToScan.length,
    assignments: scored,
    tasks: tasks.length,
    synced: Boolean(syncResult.synced),
    pending: Boolean(syncResult.pending)
  };
}

async function getUrlsToScan(originTabId, originUrl) {
  const urls = [];
  if (isBlackboardUrl(originUrl)) {
    urls.push(originUrl);
  }

  const linkResponse = await chrome.tabs.sendMessage(originTabId, { type: 'GET_COURSE_LINKS' }).catch(() => null);
  const courseLinks = Array.isArray(linkResponse?.courseLinks) ? linkResponse.courseLinks : [];

  for (const link of courseLinks) {
    if (isBlackboardUrl(link)) {
      urls.push(link);
    }
  }

  const unique = Array.from(new Set(urls));
  return unique.slice(0, AUTO_SYNC_SCAN_LIMIT);
}

async function scanUrlsFromOriginTab(originTabId, urls) {
  const all = [];

  for (const url of urls) {
    let tabId = originTabId;
    let createdTabId = null;

    if (!(await tabHasUrl(originTabId, url))) {
      const created = await chrome.tabs.create({ url, active: false });
      createdTabId = created.id;
      tabId = created.id;
      await waitForTabComplete(tabId, 45000);
    }

    const scanResponse = await chrome.tabs.sendMessage(tabId, { type: 'SCAN_PAGE' }).catch(() => null);
    const assignments = Array.isArray(scanResponse?.assignments) ? scanResponse.assignments : [];
    all.push(...assignments);

    if (createdTabId) {
      await chrome.tabs.remove(createdTabId).catch(() => null);
    }
  }

  return dedupeAssignments(all);
}

async function tabHasUrl(tabId, targetUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return Boolean(tab?.url && tab.url === targetUrl);
}

async function waitForTabComplete(tabId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error('Tab closed before scan completed.');
    }
    if (tab.status === 'complete') return;
    await delay(250);
  }

  throw new Error('Timed out waiting for tab to finish loading.');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupeAssignments(assignments) {
  const out = [];
  const seen = new Set();

  for (const assignment of assignments || []) {
    const key = assignment.id
      || `${assignment.title || ''}|${assignment.courseName || assignment.course || ''}|${assignment.dueAt || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(assignment);
  }

  return out;
}

async function handleSyncPending() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PENDING_SYNC);
  const pending = data[STORAGE_KEYS.PENDING_SYNC];

  if (!pending || !Array.isArray(pending.tasks) || !pending.tasks.length) {
    return { synced: false, pending: false, reason: 'No pending payload' };
  }

  return syncToRpg(pending.tasks);
}

async function upsertScanResults(assignments) {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.RESULTS);
  const currentMap = existing[STORAGE_KEYS.RESULTS] || {};

  for (const assignment of assignments) {
    const key = assignment.id || `${assignment.title}|${assignment.courseName || assignment.course || ''}|${assignment.dueAt || ''}`;
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

function toTask(item) {
  return {
    id: item.id,
    title: item.title,
    dueAt: item.dueAt || null,
    courseName: item.courseName || item.course || 'Unknown course',
    url: item.url || '',
    priorityScore: item.priorityScore ?? item.urgencyScore ?? 20,
    recommendedXP: item.recommendedXP ?? item.recommendedXp ?? 20
  };
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

function isBlackboardUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('blackboard') || /\/ultra\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}
