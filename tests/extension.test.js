'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = process.cwd();

function loadScript(file, context) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInNewContext(source, context, { filename: file });
}

function makeEvent() {
  const listeners = new Set();
  return {
    addListener(fn) {
      listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    emit(...args) {
      for (const fn of Array.from(listeners)) fn(...args);
    },
    count() {
      return listeners.size;
    }
  };
}

function createServiceWorkerContext(overrides = {}) {
  const storageData = structuredClone(overrides.storageData || {});
  const onInstalled = makeEvent();
  const onMessage = makeEvent();
  const onUpdated = makeEvent();

  let nextTabId = 100;
  const tabsState = [...(overrides.tabs || [])];
  const removedTabs = [];
  const executeCalls = [];
  const sentMessages = [];

  const perTabScans = overrides.perTabScans || new Map();
  const courseLinks = overrides.courseLinks || [];
  const rpgAck = overrides.rpgAck || { ok: true };

  const chrome = {
    runtime: {
      onInstalled,
      onMessage
    },
    storage: {
      local: {
        async get(keyOrKeys) {
          if (Array.isArray(keyOrKeys)) {
            const out = {};
            for (const k of keyOrKeys) out[k] = storageData[k];
            return out;
          }
          if (typeof keyOrKeys === 'string') {
            return { [keyOrKeys]: storageData[keyOrKeys] };
          }
          return { ...storageData };
        },
        async set(obj) {
          Object.assign(storageData, obj);
        }
      }
    },
    tabs: {
      onUpdated,
      async query() {
        return tabsState;
      },
      async get(tabId) {
        return tabsState.find((t) => t.id === tabId) || null;
      },
      async create({ url, active }) {
        const tab = { id: nextTabId++, url, active: Boolean(active) };
        tabsState.push(tab);
        setTimeout(() => {
          onUpdated.emit(tab.id, { status: 'complete' }, tab);
        }, 0);
        return tab;
      },
      async update(tabId, patch) {
        const tab = tabsState.find((t) => t.id === tabId);
        if (tab && patch && Object.prototype.hasOwnProperty.call(patch, 'active')) {
          tab.active = Boolean(patch.active);
        }
        return tab;
      },
      async remove(tabId) {
        removedTabs.push(tabId);
        const idx = tabsState.findIndex((t) => t.id === tabId);
        if (idx >= 0) tabsState.splice(idx, 1);
      },
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
        if (message.type === 'GET_COURSE_LINKS') {
          assert.equal(tabId, overrides.originTabId);
          return { courseLinks };
        }
        if (message.type === 'SCAN_PAGE') {
          return { assignments: perTabScans.get(tabId) || [] };
        }
        if (message.type === 'BB_INTEL_SYNC_V1') {
          return rpgAck;
        }
        throw new Error(`Unhandled sendMessage type: ${message.type}`);
      }
    },
    scripting: {
      async executeScript(args) {
        executeCalls.push(args);
        return [{ result: { posted: true } }];
      }
    }
  };

  const context = {
    chrome,
    console,
    Date,
    setTimeout,
    clearTimeout
  };

  loadScript('service_worker.js', context);

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      const listeners = [onMessage.emit.bind(onMessage)];
      const sender = { tab: { id: overrides.originTabId } };
      listeners[0](message, sender, (response) => resolve(response));
    });
  }

  return {
    chrome,
    storageData,
    onInstalled,
    onMessage,
    tabsState,
    removedTabs,
    executeCalls,
    sentMessages,
    sendRuntimeMessage
  };
}

function createBasicElement(id = '') {
  return {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    href: '',
    download: '',
    listeners: {},
    children: [],
    addEventListener(type, cb) {
      this.listeners[type] = cb;
    },
    click() {
      this.clicked = true;
    },
    appendChild(node) {
      this.children.push(node);
      this.lastChild = node;
      return node;
    }
  };
}

function createPopupContext(overrides = {}) {
  const storageData = structuredClone(overrides.storageData || {});
  const elements = {
    status: createBasicElement('status'),
    assignmentList: createBasicElement('assignmentList'),
    scanPageBtn: createBasicElement('scanPageBtn'),
    guidedScanBtn: createBasicElement('guidedScanBtn'),
    syncBtn: createBasicElement('syncBtn'),
    syncPendingBtn: createBasicElement('syncPendingBtn'),
    sendTestTaskBtn: createBasicElement('sendTestTaskBtn'),
    openOptions: createBasicElement('openOptions'),
    debugTitlesToggle: createBasicElement('debugTitlesToggle')
  };

  const createdAnchors = [];
  const urlCalls = [];
  const runtimeMessages = [];

  const chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') return { [key]: storageData[key] };
          return { ...storageData };
        },
        async set(obj) {
          Object.assign(storageData, obj);
        }
      }
    },
    tabs: {
      async query() {
        return [overrides.activeTab || { id: 11 }];
      },
      async sendMessage(_tabId, msg) {
        if (msg.type === 'SCAN_PAGE') {
          return { assignments: overrides.scannedAssignments || [] };
        }
        throw new Error(`Unhandled tabs.sendMessage type: ${msg.type}`);
      }
    },
    runtime: {
      async sendMessage(payload) {
        runtimeMessages.push(payload);
        if (payload.type === 'GUIDED_SCAN_ALL_COURSES') {
          return overrides.guidedResponse || { ok: true, scanned: 2 };
        }
        if (payload.type === 'SYNC_TO_RPG') {
          return overrides.syncResponse || { ok: true };
        }
        return { ok: true };
      },
      openOptionsPage() {
        return true;
      }
    }
  };

  const document = {
    getElementById(id) {
      return elements[id];
    },
    createElement(tag) {
      const el = createBasicElement();
      el.tagName = tag.toUpperCase();
      if (tag.toLowerCase() === 'a') {
        createdAnchors.push(el);
      }
      return el;
    }
  };

  const context = {
    chrome,
    document,
    Blob,
    URL: {
      createObjectURL(blob) {
        urlCalls.push({ op: 'create', blob });
        return 'blob://fake';
      },
      revokeObjectURL(url) {
        urlCalls.push({ op: 'revoke', url });
      }
    },
    setTimeout,
    clearTimeout,
    Date,
    console
  };

  loadScript('popup.js', context);

  return { context, elements, storageData, runtimeMessages, createdAnchors, urlCalls };
}

function createOptionsContext(overrides = {}) {
  const storageData = structuredClone(overrides.storageData || {});
  const elements = {
    rpgUrl: createBasicElement('rpgUrl'),
    status: createBasicElement('status'),
    saveBtn: createBasicElement('saveBtn')
  };

  const chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') return { [key]: storageData[key] };
          return { ...storageData };
        },
        async set(obj) {
          Object.assign(storageData, obj);
        }
      }
    }
  };

  const document = {
    getElementById(id) {
      return elements[id];
    }
  };

  const context = {
    chrome,
    document,
    URL,
    console
  };

  loadScript('options.js', context);

  return { context, elements, storageData };
}

function createContentScriptContext(documentMock) {
  const onMessage = makeEvent();
  const context = {
    chrome: {
      runtime: {
        onMessage
      }
    },
    document: documentMock,
    Date,
    console
  };
  loadScript('contentScript.js', context);
  return { context, onMessage };
}

test('service worker initializes default settings/results on install', async () => {
  const sw = createServiceWorkerContext();
  sw.onInstalled.emit();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sw.storageData.settings.rpgUrl, 'https://bramyx1.github.io/Personal-Productivity-RPG/');
  assert.equal(Object.keys(sw.storageData.scanResults || {}).length, 0);
});

test('service worker sync falls back to default rpgUrl and saves pending when RPG tab is not open', async () => {
  const sw = createServiceWorkerContext({ storageData: { settings: { rpgUrl: '' } } });
  const response = await sw.sendRuntimeMessage({ type: 'SYNC_TO_RPG', payload: { assignments: [] } });
  assert.equal(response.ok, true);
  assert.equal(response.synced, false);
  assert.equal(response.pending, true);
  assert.ok(sw.storageData.pendingSync);
});

test('service worker sync posts assignments to matching tab', async () => {
  const sw = createServiceWorkerContext({
    storageData: { settings: { rpgUrl: 'https://rpg.example.com' } },
    tabs: [{ id: 3, url: 'https://rpg.example.com/app', active: false }]
  });

  const response = await sw.sendRuntimeMessage({
    type: 'SYNC_TO_RPG',
    payload: { tasks: [{ id: 'a1' }] }
  });

  assert.equal(response.ok, true);
  assert.equal(response.synced, true);
  const sent = sw.sentMessages.find((m) => m.message.type === 'BB_INTEL_SYNC_V1');
  assert.ok(sent);
  assert.equal(sent.message.payload.tasks.length, 1);
});

test('service worker guided scan scans current tab and stores scored assignments', async () => {
  const originTabId = 7;
  const sw = createServiceWorkerContext({
    originTabId,
    storageData: { settings: { rpgUrl: 'https://rpg.example.com' }, scanResults: {} },
    tabs: [{ id: originTabId, url: 'https://bb.example.com/ultra/stream', active: true }],
    courseLinks: ['https://bb.example.com/course-1', 'https://bb.example.com/course-2']
  });

  sw.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type === 'GET_COURSE_LINKS' && tabId === originTabId) {
      return { courseLinks: ['https://bb.example.com/course-1'] };
    }
    if (message.type === 'SCAN_PAGE' && tabId === originTabId) {
      return {
        assignments: [
          {
            id: 'c1-a1',
            title: 'Midterm Project',
            dueAt: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
            course: 'Course 1',
            url: 'https://bb.example.com/a1'
          }
        ]
      };
    }
    return { assignments: [] };
  };

  const response = await sw.sendRuntimeMessage({ type: 'GUIDED_SCAN_ALL_COURSES', tabId: originTabId });
  assert.equal(response.ok, true);

  const stored = Object.values(sw.storageData.scanResults);
  if (stored.length) {
    assert.equal(typeof stored[0].urgencyScore, 'number');
    assert.equal(typeof stored[0].recommendedXp, 'number');
  }
});

test('popup scan stores scored assignments and updates status', async () => {
  const due = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const popup = createPopupContext({
    scannedAssignments: [{ id: 'x1', title: 'Quiz 1', dueAt: due, course: 'C1', url: 'https://x' }],
    storageData: { scanResults: {} }
  });

  await popup.context.onScanPage();
  assert.match(popup.elements.status.textContent, /Scanned 1 tasks/);
  const stored = Object.values(popup.storageData.scanResults);
  assert.equal(stored.length, 1);
  assert.equal(typeof stored[0].priorityScore, 'number');
  assert.equal(typeof stored[0].recommendedXP, 'number');
});

test('popup sync sends assignments payload to service worker', async () => {
  const popup = createPopupContext({
    storageData: {
      scanResults: {
        a1: { id: 'a1', title: 'Assignment 1' }
      }
    }
  });

  await popup.context.onSyncToRpg();
  const syncMessage = popup.runtimeMessages.find((m) => m.type === 'SYNC_TO_RPG');
  assert.ok(syncMessage);
  assert.equal(syncMessage.payload.tasks.length, 1);
});

test('popup send test task routes one task to sync', async () => {
  const popup = createPopupContext({
    storageData: { scanResults: {} }
  });

  await popup.context.onSendTestTask();
  const syncMessage = popup.runtimeMessages.find((m) => m.type === 'SYNC_TO_RPG');
  assert.ok(syncMessage);
  assert.equal(syncMessage.payload.tasks.length, 1);
  assert.match(syncMessage.payload.tasks[0].id, /^bb-intel-test-/);
});

test('options validates URL and saves valid rpgUrl', async () => {
  const options = createOptionsContext({ storageData: { settings: { rpgUrl: 'https://old.example.com' } } });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(options.elements.rpgUrl.value, 'https://old.example.com');

  options.elements.rpgUrl.value = 'bad-url';
  await options.context.onSave();
  assert.match(options.elements.status.textContent, /valid URL/);

  options.elements.rpgUrl.value = 'https://rpg.example.com';
  await options.context.onSave();
  assert.equal(options.storageData.settings.rpgUrl, 'https://rpg.example.com');
  assert.match(options.elements.status.textContent, /Options saved/);
});

test('content script extracts assignments and course links', () => {
  const anchor1 = {
    textContent: 'Assignment 1',
    href: 'https://bb.example.com/assign1',
    closest() {
      return { textContent: 'Assignment 1 Due: Jan 20, 2027 11:59 PM' };
    },
    parentElement: null
  };

  const anchor2 = {
    textContent: 'My Course - Biology',
    href: 'https://bb.example.com/ultra/courses/abc',
    closest() {
      return { textContent: 'My Course - Biology' };
    },
    parentElement: null
  };

  const doc = {
    title: 'Biology 101',
    querySelector(selector) {
      if (selector === 'h1') return { textContent: 'Biology 101' };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a') return [anchor1, anchor2];
      if (selector === 'a[href]') return [anchor1, anchor2];
      return [];
    }
  };

  const { context } = createContentScriptContext(doc);
  const assignments = context.extractAssignmentsFromPage();
  const courses = context.extractCourseLinks();

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].title, 'Assignment 1');
  assert.ok(assignments[0].dueAt);
  assert.equal(courses.length, 1);
  assert.match(courses[0], /ultra\/courses/);
});
