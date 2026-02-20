'use strict';

const STORAGE_KEYS = {
  RESULTS: 'scanResults',
  SETTINGS: 'settings'
};

const statusEl = document.getElementById('status');
const assignmentListEl = document.getElementById('assignmentList');
const debugTitlesToggleEl = document.getElementById('debugTitlesToggle');

document.getElementById('scanPageBtn').addEventListener('click', onScanPage);
document.getElementById('guidedScanBtn').addEventListener('click', onGuidedScan);
document.getElementById('syncBtn').addEventListener('click', onSyncToRpg);
document.getElementById('syncPendingBtn').addEventListener('click', onSyncPending);
document.getElementById('sendTestTaskBtn').addEventListener('click', onSendTestTask);
document.getElementById('openOptions').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});
debugTitlesToggleEl.addEventListener('change', onToggleDebugTitles);

init().catch((error) => setStatus(`Init failed: ${error.message}`));

async function init() {
  await loadSettings();
  const results = await getStoredAssignments();
  renderAssignments(results);
}

async function onScanPage() {
  setStatus('Scanning current page...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab found.');
    return;
  }

  const settings = await getSettings();
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'SCAN_PAGE',
    debugTitles: Boolean(settings.debugTitles)
  }).catch(() => null);
  const scanned = response?.assignments || [];
  const scored = scanned.map(scoreAssignment).map(toTask);

  await mergeAssignments(scored);
  const merged = await getStoredAssignments();
  renderAssignments(merged);

  const syncResult = await syncToRpg(scored, false);
  if (syncResult.outcome === 'synced') {
    setStatus(`Scanned ${scored.length} tasks. Synced to RPG.`);
    return;
  }
  if (syncResult.outcome === 'pending') {
    setStatus(`Scanned ${scored.length} tasks. Pending saved. Open RPG and click Sync Now.`);
    return;
  }
  setStatus(`Scanned ${scored.length} tasks. Sync failed.`);
}

async function onGuidedScan() {
  setStatus('Guided scan started. Opening course tabs in background...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab found.');
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'GUIDED_SCAN_ALL_COURSES',
    tabId: tab.id
  });

  if (!response?.ok) {
    setStatus(`Guided scan failed: ${response?.error || 'Unknown error'}`);
    return;
  }

  const results = await getStoredAssignments();
  renderAssignments(results);
  setStatus(`Guided scan done. Courses scanned: ${response.scanned}.`);
}

async function onSyncToRpg() {
  setStatus('Syncing to RPG...');
  const tasks = (await getStoredAssignments()).map(toTask);
  const syncResult = await syncToRpg(tasks, true);
  if (syncResult.outcome === 'synced') {
    setStatus('Synced to RPG.');
    return;
  }
  if (syncResult.outcome === 'pending') {
    setStatus('RPG tab not open. Pending sync saved.');
    return;
  }
  setStatus(`Sync failed: ${syncResult.error || 'Unknown error'}`);
}

async function onSyncPending() {
  setStatus('Sending pending sync...');
  const response = await chrome.runtime.sendMessage({ type: 'SYNC_PENDING' });
  if (!response?.ok) {
    setStatus(`Sync failed: ${response?.error || 'Unknown error'}`);
    return;
  }
  if (response.synced) {
    setStatus('Synced pending tasks to RPG.');
    return;
  }
  if (response.pending) {
    setStatus('Pending sync exists. Open RPG tab and click Sync Now again.');
    return;
  }
  setStatus('No pending payload.');
}

async function onSendTestTask() {
  setStatus('Sending test task...');
  const now = Date.now();
  const task = {
    id: `bb-intel-test-${now}`,
    title: 'BB Intel Sync Test Task',
    dueAt: new Date(now + 24 * 3600 * 1000).toISOString(),
    courseName: 'Sync Test',
    url: '',
    priorityScore: 42,
    recommendedXP: 60
  };
  const syncResult = await syncToRpg([task], true);
  if (syncResult.outcome === 'synced') {
    setStatus('Test task sent to RPG.');
    return;
  }
  if (syncResult.outcome === 'pending') {
    setStatus('RPG tab not open. Test task saved to pending sync.');
    return;
  }
  setStatus(`Test task sync failed: ${syncResult.error || 'Unknown error'}`);
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return data[STORAGE_KEYS.SETTINGS] || {};
}

async function loadSettings() {
  const settings = await getSettings();
  debugTitlesToggleEl.checked = Boolean(settings.debugTitles);
}

async function onToggleDebugTitles() {
  const settings = await getSettings();
  settings.debugTitles = Boolean(debugTitlesToggleEl.checked);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  setStatus(`Debug titles ${settings.debugTitles ? 'enabled' : 'disabled'}.`);
}

async function getStoredAssignments() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.RESULTS);
  const map = data[STORAGE_KEYS.RESULTS] || {};
  return Object.values(map).sort((a, b) => {
    const ad = a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER;
    const bd = b.dueAt ? Date.parse(b.dueAt) : Number.MAX_SAFE_INTEGER;
    return ad - bd;
  });
}

async function mergeAssignments(assignments) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.RESULTS);
  const map = data[STORAGE_KEYS.RESULTS] || {};
  for (const assignment of assignments) {
    const key = assignment.id || `${assignment.title}|${assignment.courseName || assignment.course}|${assignment.dueAt || ''}`;
    map[key] = assignment;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.RESULTS]: map });
}

function renderAssignments(assignments) {
  assignmentListEl.innerHTML = '';

  if (!assignments.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No assignments scanned yet.';
    assignmentListEl.appendChild(empty);
    return;
  }

  for (const item of assignments.slice(0, 120)) {
    const li = document.createElement('li');
    const dueText = item.dueAt ? new Date(item.dueAt).toLocaleString() : 'No due date found';
    const courseName = item.courseName || item.course || 'Unknown course';
    const priority = item.priorityScore ?? item.urgencyScore ?? '-';
    const xp = item.recommendedXP ?? item.recommendedXp ?? '-';
    li.innerHTML = `
      <div class="title">${escapeHtml(item.title || 'Untitled')}</div>
      <div class="meta">${escapeHtml(courseName)}</div>
      <div class="meta">Due: ${escapeHtml(dueText)}</div>
      <div class="meta">Priority: ${priority} | XP: ${xp}</div>
    `;
    assignmentListEl.appendChild(li);
  }
}

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function scoreAssignment(assignment) {
  const now = Date.now();
  const dueMs = assignment.dueAt ? Date.parse(assignment.dueAt) : NaN;

  let urgencyScore = Number.isFinite(assignment.urgencyScore)
    ? Math.max(0, Math.min(100, Number(assignment.urgencyScore)))
    : null;
  if (urgencyScore === null) {
    urgencyScore = 20;
    if (!Number.isNaN(dueMs)) {
      const hoursLeft = (dueMs - now) / 36e5;
      if (hoursLeft <= 0) urgencyScore = 100;
      else if (hoursLeft <= 24) urgencyScore = 90;
      else if (hoursLeft <= 72) urgencyScore = 75;
      else if (hoursLeft <= 168) urgencyScore = 55;
      else urgencyScore = 35;
    }
  }

  const complexity = estimateComplexity(assignment.title || '');
  const recommendedXp = Number.isFinite(assignment.recommendedXp)
    ? Number(assignment.recommendedXp)
    : Math.round(20 + urgencyScore * 0.8 + complexity * 0.6);

  return {
    ...assignment,
    urgencyScore,
    recommendedXp
  };
}

function estimateComplexity(title) {
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

async function syncToRpg(tasks, allowEmpty) {
  const taskList = Array.isArray(tasks) ? tasks : [];
  if (!allowEmpty && !taskList.length) {
    return { outcome: 'empty' };
  }

  const response = await chrome.runtime.sendMessage({
    type: 'SYNC_TO_RPG',
    payload: { tasks: taskList }
  }).catch((error) => ({ ok: false, error: error?.message || 'Failed to send runtime message.' }));

  if (!response?.ok) {
    return { outcome: 'error', error: response?.error || 'Unknown error' };
  }
  if (response.synced) {
    return { outcome: 'synced' };
  }
  if (response.pending) {
    return { outcome: 'pending' };
  }
  return { outcome: 'unknown' };
}
