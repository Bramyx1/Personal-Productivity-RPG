console.log("RPG SYNC RECEIVER LOADED");
const STORAGE_KEY = "executiveOperatingSystemState";
const MAX_BRIEF_ENTRIES = 10;
const MAX_HISTORY_ENTRIES = 20;
console.log("RPG app.js LOADED - version Feb18");

const DIFFICULTY_REWARDS = {
  Easy: { xp: 10, capital: 5 },
  Medium: { xp: 25, capital: 12 },
  Hard: { xp: 50, capital: 25 },
  "Quick Win": { xp: 12, capital: 6 },
  Standard: { xp: 24, capital: 12 },
  "High Impact": { xp: 42, capital: 21 }
};

const SHOP_ITEMS = {
  Coffee: {
    cost: 30,
    apply: () => gainXP(10),
    message: "Coffee acquired: +10 XP"
  },
  "Deep Work Potion": {
    cost: 60,
    apply: () => {
      state.stats.Focus += 1;
    },
    message: "Deep Work Potion acquired: +1 Focus"
  },
  "Discipline Token": {
    cost: 60,
    apply: () => {
      state.stats.Discipline += 1;
    },
    message: "Discipline Token acquired: +1 Discipline"
  },
  "Execution Scroll": {
    cost: 60,
    apply: () => {
      state.stats.Execution += 1;
    },
    message: "Execution Scroll acquired: +1 Execution"
  }
};

function makeId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getRankTitle(level) {
  if (level >= 9) return "Chief Execution Officer";
  if (level >= 7) return "VP Of Performance";
  if (level >= 5) return "Director Of Execution";
  if (level >= 3) return "Senior Operator";
  return "Associate Operator";
}

function createSampleActions() {
  return [
    { id: makeId(), name: "Plan your top 3 priorities", difficulty: "Easy", completed: false },
    { id: makeId(), name: "Deep work sprint (45 mins)", difficulty: "Medium", completed: false },
    { id: makeId(), name: "Ship one major deliverable", difficulty: "Hard", completed: false }
  ];
}

function createDefaultState() {
  return {
    level: 1,
    xp: 0,
    xpNeeded: 100,
    capital: 0,
    streak: 0,
    lastCompletionDate: "",
    stats: {
      Focus: 1,
      Discipline: 1,
      Execution: 1
    },
    actions: createSampleActions(),
    history: [],
    brief: []
  };
}

let state = loadState();
state = mergeSchoolOpsActions(state);
let lastFocusedElement = null;

const ui = {
  level: document.getElementById("level"),
  rankTitle: document.getElementById("rank-title"),
  xpBar: document.getElementById("xp-bar"),
  xpText: document.getElementById("xp-text"),
  capital: document.getElementById("capital"),
  streak: document.getElementById("streak"),
  todayCompleted: document.getElementById("today-completed"),
  focus: document.getElementById("focus"),
  discipline: document.getElementById("discipline"),
  execution: document.getElementById("execution"),
  actionForm: document.getElementById("action-form"),
  actionName: document.getElementById("action-name"),
  actionDifficulty: document.getElementById("action-difficulty"),
  actionList: document.getElementById("action-list"),
  historyList: document.getElementById("history-list"),
  briefList: document.getElementById("brief-list"),
  shopButtons: document.querySelectorAll(".shop-btn"),
  resetButton: document.getElementById("reset-btn"),
  helpModal: document.getElementById("help-modal"),
  helpPanel: document.getElementById("help-panel"),
  helpOpenBtn: document.getElementById("help-open-btn"),
  helpCloseBtn: document.getElementById("help-close-btn"),
  helpOverlay: document.getElementById("help-overlay"),
  toastContainer: document.getElementById("toast-container")
};

bindEvents();
if (reconcileStreakForToday()) {
  saveState();
}
render();

function bindEvents() {
  ui.actionForm.addEventListener("submit", onAddAction);
  ui.helpOpenBtn.addEventListener("click", openHelpModal);
  ui.helpCloseBtn.addEventListener("click", closeHelpModal);
  ui.helpOverlay.addEventListener("click", closeHelpModal);
  ui.resetButton.addEventListener("click", onReset);
  document.addEventListener("keydown", onGlobalKeyDown);

  for (const button of ui.shopButtons) {
    button.addEventListener("click", onShopPurchase);
  }

  window.addEventListener("message", onBlackboardWindowMessage);
}

function loadState() {
  const fallback = createDefaultState();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return sanitizeState(parsed, fallback);
  } catch {
    return fallback;
  }
}

function sanitizeState(candidate, fallback) {
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  return {
    level: Number.isInteger(candidate.level) && candidate.level > 0 ? candidate.level : 1,
    xp: Number.isInteger(candidate.xp) && candidate.xp >= 0 ? candidate.xp : 0,
    xpNeeded:
      Number.isInteger(candidate.xpNeeded) && candidate.xpNeeded > 0 ? candidate.xpNeeded : 100,
    capital: Number.isInteger(candidate.capital)
      ? Math.max(0, candidate.capital)
      : Number.isInteger(candidate.coins)
        ? Math.max(0, candidate.coins)
        : 0,
    streak: Number.isInteger(candidate.streak) && candidate.streak >= 0 ? candidate.streak : 0,
    lastCompletionDate:
      typeof candidate.lastCompletionDate === "string" ? candidate.lastCompletionDate : "",
    stats: {
      Focus:
        Number.isInteger(candidate?.stats?.Focus) && candidate.stats.Focus > 0
          ? candidate.stats.Focus
          : 1,
      Discipline:
        Number.isInteger(candidate?.stats?.Discipline) && candidate.stats.Discipline > 0
          ? candidate.stats.Discipline
          : 1,
      Execution:
        Number.isInteger(candidate?.stats?.Execution) && candidate.stats.Execution > 0
          ? candidate.stats.Execution
          : Number.isInteger(candidate?.stats?.Knowledge) && candidate.stats.Knowledge > 0
            ? candidate.stats.Knowledge
            : 1
    },
    actions: sanitizeActions(candidate.actions || candidate.tasks, fallback.actions),
    history: sanitizeHistory(candidate.history),
    brief: sanitizeBrief(candidate.brief || candidate.eventLog)
  };
}

function sanitizeActions(candidate, fallback) {
  if (!Array.isArray(candidate)) {
    return fallback;
  }

  return candidate
    .filter((item) => item && typeof item.name === "string" && DIFFICULTY_REWARDS[item.difficulty])
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : makeId(),
      name: item.name.trim(),
      difficulty: item.difficulty,
      completed: item.completed === true || item.status === "completed",
      completedAt: typeof item.completedAt === "string" ? item.completedAt : "",
      source: typeof item.source === "string" ? item.source : "",
      sourceId: typeof item.sourceId === "string" ? item.sourceId : "",
      sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : "",
      dueAt: typeof item.dueAt === "string" ? item.dueAt : "",
      courseName: typeof item.courseName === "string" ? item.courseName : "",
      priorityScore:
        typeof item.priorityScore === "number" && Number.isFinite(item.priorityScore)
          ? item.priorityScore
          : null
    }))
    .filter((item) => item.name.length > 0);
}

function sanitizeHistory(candidate) {
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate
    .filter((item) => item && typeof item.name === "string" && DIFFICULTY_REWARDS[item.difficulty])
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : makeId(),
      name: item.name.trim(),
      difficulty: item.difficulty,
      completedAt: typeof item.completedAt === "string" ? item.completedAt : "",
      archivedAt: typeof item.archivedAt === "string" ? item.archivedAt : ""
    }))
    .filter((item) => item.name.length > 0)
    .slice(0, MAX_HISTORY_ENTRIES);
}

function sanitizeBrief(candidate) {
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((item) => typeof item === "string").slice(0, MAX_BRIEF_ENTRIES);
}

function mergeSchoolOpsActions(currentState) {
  const payload = globalThis.__schoolOpsSync;
  if (!payload || !Array.isArray(payload.actions)) {
    return currentState;
  }

  const existing = Array.isArray(currentState.actions) ? currentState.actions : [];
  const existingById = new Map(existing.map((item) => [item.id, item]));

  const mergedFromSchoolOps = payload.actions
    .filter((item) => item && typeof item.name === "string" && DIFFICULTY_REWARDS[item.difficulty])
    .map((item) => {
      const prior = existingById.get(item.id);
      return {
        id: typeof item.id === "string" ? item.id : makeId(),
        name: item.name.trim(),
        difficulty: item.difficulty,
        completed: prior ? prior.completed === true : item.completed === true,
        completedAt: prior && typeof prior.completedAt === "string" ? prior.completedAt : "",
        source: "SchoolOps"
      };
    })
    .filter((item) => item.name.length > 0);

  const localCustomActions = existing.filter((item) => item?.source !== "SchoolOps");
  const merged = [...mergedFromSchoolOps, ...localCustomActions];

  return {
    ...currentState,
    actions: merged
  };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    showToast("Unable to persist state in this browser.", "error");
  }
}

function render() {
  const today = getLocalDateString(new Date());
  const todayCompleted = state.actions.filter(
    (action) => action.completed && action.completedAt === today
  ).length;

  ui.level.textContent = String(state.level);
  ui.rankTitle.textContent = getRankTitle(state.level);
  ui.capital.textContent = String(state.capital);
  ui.streak.textContent = String(state.streak);
  ui.todayCompleted.textContent = String(todayCompleted);

  ui.xpText.textContent = `${state.xp} / ${state.xpNeeded}`;
  const xpPercent = Math.min(100, Math.round((state.xp / state.xpNeeded) * 100));
  ui.xpBar.style.width = `${xpPercent}%`;

  ui.focus.textContent = String(state.stats.Focus);
  ui.discipline.textContent = String(state.stats.Discipline);
  ui.execution.textContent = String(state.stats.Execution);

  renderActions();
  renderHistory();
  renderBrief();
}

function renderActions() {
  ui.actionList.innerHTML = "";

  if (state.actions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.innerHTML = '<p>No actions queued. Set the next priority.</p><button id="add-action-cta" class="btn" type="button">Add an Action</button>';
    ui.actionList.appendChild(empty);

    const cta = document.getElementById("add-action-cta");
    cta.addEventListener("click", () => {
      ui.actionName.focus();
    });
    return;
  }

  for (const action of state.actions) {
    const reward = DIFFICULTY_REWARDS[action.difficulty];

    const item = document.createElement("li");
    item.className = `action-item${action.completed ? " completed" : ""}`;

    const left = document.createElement("div");
    const title = document.createElement("p");
    title.className = "action-title";
    title.textContent = action.name;

    const meta = document.createElement("p");
    meta.className = "action-meta";
    const badge = action.completed ? '<span class="badge">Completed</span>' : "";
    meta.innerHTML = `${badge}<span class="difficulty-tag">${action.difficulty}</span>+${reward.xp} XP • +${reward.capital} capital`;

    left.append(title, meta);

    const controls = document.createElement("div");
    controls.className = "action-controls";

    const completeButton = document.createElement("button");
    completeButton.className = "complete-btn";
    completeButton.type = "button";
    completeButton.textContent = action.completed ? "Completed" : "Complete";
    completeButton.disabled = action.completed;
    completeButton.addEventListener("click", () => completeAction(action.id));
    controls.appendChild(completeButton);

    if (action.completed) {
      const archiveButton = document.createElement("button");
      archiveButton.className = "archive-btn";
      archiveButton.type = "button";
      archiveButton.textContent = "Archive";
      archiveButton.addEventListener("click", () => archiveAction(action.id));
      controls.appendChild(archiveButton);
    }

    item.append(left, controls);
    ui.actionList.appendChild(item);
  }
}

function renderHistory() {
  ui.historyList.innerHTML = "";

  if (state.history.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.innerHTML = "<p>History is empty. Archive completed actions to keep your timeline clean.</p>";
    ui.historyList.appendChild(empty);
    return;
  }

  for (const item of state.history) {
    const row = document.createElement("li");
    row.textContent = `${item.name} • ${item.difficulty}`;
    ui.historyList.appendChild(row);
  }
}

function renderBrief() {
  ui.briefList.innerHTML = "";

  if (state.brief.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.innerHTML = "<p>Daily Brief is clear. Complete an action to generate operational updates.</p>";
    ui.briefList.appendChild(empty);
    return;
  }

  for (const entry of state.brief) {
    const row = document.createElement("li");
    row.textContent = entry;
    ui.briefList.appendChild(row);
  }
}

function onAddAction(event) {
  event.preventDefault();

  const name = ui.actionName.value.trim();
  const difficulty = ui.actionDifficulty.value;

  if (!name || !DIFFICULTY_REWARDS[difficulty]) {
    showToast("Enter an action and valid difficulty.", "error");
    return;
  }

  state.actions.push({
    id: makeId(),
    name,
    difficulty,
    completed: false,
    completedAt: ""
  });

  ui.actionForm.reset();
  saveState();
  render();
  showToast("Action added.", "success");
}

function completeAction(actionId) {
  const action = state.actions.find((item) => item.id === actionId);
  if (!action || action.completed) {
    return;
  }

  const reward = DIFFICULTY_REWARDS[action.difficulty];
  action.completed = true;
  action.completedAt = getLocalDateString(new Date());

  state.capital += reward.capital;
  gainXP(reward.xp);
  updateStreakOnCompletion();
  addBrief(`Completed: ${action.name} (+${reward.xp} XP, +${reward.capital} capital)`);

  saveState();
  render();
  showToast("Action completed.", "success");
}

function archiveAction(actionId) {
  const index = state.actions.findIndex((item) => item.id === actionId && item.completed);
  if (index === -1) {
    return;
  }

  const action = state.actions[index];
  state.actions.splice(index, 1);

  state.history.unshift({
    id: action.id,
    name: action.name,
    difficulty: action.difficulty,
    completedAt: action.completedAt,
    archivedAt: getLocalDateString(new Date())
  });

  if (state.history.length > MAX_HISTORY_ENTRIES) {
    state.history.length = MAX_HISTORY_ENTRIES;
  }

  addBrief(`Archived: ${action.name}`);
  saveState();
  render();
  showToast("Action archived.", "success");
}

function onShopPurchase(event) {
  const itemName = event.currentTarget.dataset.item;
  const item = SHOP_ITEMS[itemName];
  if (!item) {
    return;
  }

  if (state.capital < item.cost) {
    showToast(`Not enough capital for ${itemName}.`, "error");
    return;
  }

  state.capital -= item.cost;
  item.apply();
  addBrief(`${item.message} (-${item.cost} capital)`);
  saveState();
  render();
  showToast(item.message, "success");
}

function gainXP(amount) {
  state.xp += amount;
  let promoted = false;

  while (state.xp >= state.xpNeeded) {
    state.xp -= state.xpNeeded;
    state.level += 1;
    state.xpNeeded += 25;
    boostRandomStat();
    promoted = true;
  }

  if (promoted) {
    showToast(`Promotion unlocked: ${getRankTitle(state.level)}.`, "success");
  }
}

function boostRandomStat() {
  const keys = Object.keys(state.stats);
  const key = keys[Math.floor(Math.random() * keys.length)];
  state.stats[key] += 1;
}

function addBrief(message) {
  state.brief.unshift(message);
  if (state.brief.length > MAX_BRIEF_ENTRIES) {
    state.brief.length = MAX_BRIEF_ENTRIES;
  }
}

function getLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  date.setDate(date.getDate() + days);
  return getLocalDateString(date);
}

function reconcileStreakForToday() {
  if (!state.lastCompletionDate) {
    return false;
  }

  const today = getLocalDateString(new Date());
  const expectedToday = addDays(state.lastCompletionDate, 1);

  if (state.lastCompletionDate !== today && expectedToday !== today) {
    state.streak = 0;
    addBrief("Streak reset: no completed actions yesterday.");
    return true;
  }

  return false;
}

function updateStreakOnCompletion() {
  const today = getLocalDateString(new Date());

  if (!state.lastCompletionDate) {
    state.streak = 1;
  } else if (state.lastCompletionDate === today) {
    return;
  } else if (addDays(state.lastCompletionDate, 1) === today) {
    state.streak += 1;
  } else {
    state.streak = 1;
  }

  state.lastCompletionDate = today;
}

function onReset() {
  const shouldReset = window.confirm("Reset the Executive Operating System and clear local progress?");
  if (!shouldReset) {
    return;
  }

  state = createDefaultState();
  saveState();
  render();
  showToast("System reset complete.", "success");
}

function openHelpModal() {
  lastFocusedElement = document.activeElement;
  ui.helpModal.classList.remove("hidden");
  ui.helpModal.setAttribute("aria-hidden", "false");
  ui.helpPanel.focus();
}

function closeHelpModal() {
  ui.helpModal.classList.add("hidden");
  ui.helpModal.setAttribute("aria-hidden", "true");
  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
    lastFocusedElement.focus();
  }
}

function onGlobalKeyDown(event) {
  if (event.key === "Escape" && !ui.helpModal.classList.contains("hidden")) {
    closeHelpModal();
  }
}

function onBlackboardWindowMessage(event) {
  if (event.origin !== window.location.origin) {
    return;
  }

  const msg = event.data;
  if (!msg || msg.channel !== "BB_INTEL_SYNC_V1") {
    return;
  }

  const tasks = msg.payload?.tasks || [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return;
  }

  importFromBlackboard(tasks);
}

function importFromBlackboard(tasks) {
  if (!tasks.length) {
    showToast("Imported 0 tasks from Blackboard", "success");
    return;
  }

  const existingKeys = new Set(
    (state.actions || [])
      .map((action) => getTaskDedupeKey(action))
      .filter(Boolean)
  );
  const seenIncoming = new Set();
  const imported = [];

  for (const task of tasks) {
    const action = taskToAction(task);
    if (!action) {
      continue;
    }

    const dedupeKey = getTaskDedupeKey(action);
    if (!dedupeKey || existingKeys.has(dedupeKey) || seenIncoming.has(dedupeKey)) {
      continue;
    }

    seenIncoming.add(dedupeKey);
    imported.push(action);
  }

  if (!imported.length) {
    showToast("Imported 0 tasks from Blackboard", "success");
    return;
  }

  state.actions = [...imported, ...state.actions];
  sortActionsByUrgency();
  addBrief(`Imported ${imported.length} tasks from Blackboard`);
  saveState();
  render();
  showToast(`Imported ${imported.length} tasks from Blackboard`, "success");
}

function taskToAction(task) {
  if (!task || typeof task.title !== "string") {
    return null;
  }

  const rawTitle = task.title.trim();
  if (!rawTitle) {
    return null;
  }

  const recommendedXP = Number.parseInt(task.recommendedXP, 10);
  const difficulty = mapDifficultyByRecommendedXP(recommendedXP);
  const sourceId = typeof task.id === "string" ? task.id : "";
  const sourceUrl = typeof task.url === "string" ? task.url : "";
  const dueAt = typeof task.dueAt === "string" ? task.dueAt : "";
  const courseName = typeof task.courseName === "string" ? task.courseName : "";
  const priorityScore = Number.isFinite(task.priorityScore)
    ? task.priorityScore
    : Number.parseInt(task.priorityScore, 10);
  const title = `${courseName ? `[${courseName}] ` : ""}${rawTitle || "Untitled task"}`.trim();

  return {
    id: sourceId ? `bb-${sourceId}` : `bb-${makeId()}`,
    name: title,
    difficulty,
    xpReward: Number.isFinite(recommendedXP) ? recommendedXP : 0,
    capitalReward: 0,
    completed: false,
    completedAt: "",
    createdAt: new Date().toISOString(),
    source: "Blackboard",
    sourceId,
    sourceUrl,
    dueAt,
    courseName,
    priorityScore: Number.isFinite(priorityScore) ? priorityScore : null,
    typeGuess: typeof task.typeGuess === "string" ? task.typeGuess : null
  };
}

function getTaskDedupeKey(action) {
  const sourceUrl = typeof action?.sourceUrl === "string" ? action.sourceUrl.trim() : "";
  const sourceId = typeof action?.sourceId === "string" ? action.sourceId.trim() : "";
  if (sourceUrl) {
    return `url:${sourceUrl}`;
  }
  if (sourceId) {
    return `id:${sourceId}`;
  }
  return "";
}

function mapDifficultyByRecommendedXP(recommendedXP) {
  if (!Number.isFinite(recommendedXP)) {
    return "Standard";
  }
  if (recommendedXP <= 30) {
    return "Quick Win";
  }
  if (recommendedXP <= 80) {
    return "Standard";
  }
  return "High Impact";
}

function sortActionsByUrgency() {
  const now = Date.now();
  const toTs = (d) => {
    if (!d) return null;
    const ts = Date.parse(d);
    return Number.isFinite(ts) ? ts : null;
  };

  state.actions.sort((a, b) => {
    const ad = toTs(a.dueAt);
    const bd = toTs(b.dueAt);

    const aOver = ad !== null && ad < now;
    const bOver = bd !== null && bd < now;
    if (aOver !== bOver) return aOver ? -1 : 1;

    if (ad !== null && bd !== null && ad !== bd) return ad - bd;
    if (ad !== null && bd === null) return -1;
    if (ad === null && bd !== null) return 1;

    return Number(b.priorityScore || 0) - Number(a.priorityScore || 0);
  });
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  ui.toastContainer.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 2400);
}
