#!/usr/bin/env bash
# blackboard_export.sh
# macOS: export Blackboard data (courses/assignments/announcements) after login.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 https://wku.blackboard.com"
  exit 1
fi

BLACKBOARD_BASE_URL="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${HOME}/.blackboard-export"
OUT_DIR="${WORKDIR}/out"
PROFILE_DIR="${WORKDIR}/profile"
DEBUG_TITLE_EXTRACTION="${DEBUG_TITLE_EXTRACTION:-0}"
CALENDAR_OVERRIDES="${SCRIPT_DIR}/calendar_sources/due_date_overrides.json"

mkdir -p "$WORKDIR" "$OUT_DIR" "$PROFILE_DIR"
cd "$WORKDIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it first (brew install node)."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js/npm first."
  exit 1
fi

if [[ ! -f package.json ]]; then
  cat > package.json <<'JSON'
{
  "name": "blackboard-export",
  "version": "1.0.0",
  "private": true,
  "description": "Local Blackboard export runner"
}
JSON
fi

npm install playwright >/dev/null 2>&1
npx playwright install chromium >/dev/null 2>&1

cat > scrape_blackboard.mjs <<'JS_SCRAPE'
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright';

const base = process.env.BLACKBOARD_BASE_URL;
const outDir = process.env.OUT_DIR;
const profileDir = process.env.PROFILE_DIR;
const debugTitleExtraction = process.env.DEBUG_TITLE_EXTRACTION === '1';
const calendarOverridesPath = process.env.CALENDAR_OVERRIDES;
let calendarOverrides = null;

function ask(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(msg, () => {
    rl.close();
    resolve();
  }));
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function normalizeUrl(origin, value) {
  try {
    return new URL(value, origin).toString();
  } catch {
    return null;
  }
}

function canonicalCourseUrl(value, origin) {
  const normalized = normalizeUrl(origin, value);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    if (u.origin !== origin) return null;

    const ultra = u.pathname.match(/\/ultra\/courses\/_[^/?#]+/i);
    if (ultra) return `${origin}${ultra[0]}/outline`;

    if (u.pathname.toLowerCase().includes('/webapps/blackboard/content/listcontent.jsp') && u.searchParams.get('course_id')) {
      return u.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function extractCourseId(courseUrl) {
  const m = courseUrl.match(/\/ultra\/courses\/(_[^/?#]+)/i);
  if (!m) return null;
  return m[1];
}

function extractDateFromText(text) {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();

  const now = new Date();
  const currentYear = now.getFullYear();

  const parseCandidate = (candidate) => {
    const cleaned = candidate
      .replace(/\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/gi, '')
      .replace(/\bby\b/gi, ' ')
      .replace(/(\d{1,2})\s*:\s*(\d{2})/g, '$1:$2')
      .replace(/^([A-Za-z]{3,9}),\s+([A-Za-z]{3,9}\s+\d{1,2})/i, '$2')
      .replace(/\s+/g, ' ')
      .trim();

    const hasYear = /\b(19|20)\d{2}\b/.test(cleaned);
    if (hasYear) {
      const direct = Date.parse(cleaned);
      if (!Number.isNaN(direct)) return new Date(direct).toISOString();
    }

    const noYear = cleaned.match(/^([A-Za-z]{3,9}\s+\d{1,2})(?:\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?))?$/i);
    if (noYear) {
      const withYear = `${noYear[1]}, ${currentYear}${noYear[2] ? ` ${noYear[2]}` : ''}`;
      const parsed = Date.parse(withYear);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }

    const fallback = Date.parse(cleaned);
    if (!Number.isNaN(fallback)) return new Date(fallback).toISOString();

    return null;
  };

  const patterns = [
    /(?:due|deadline|available until|available)\s*[:\-]?\s*([A-Za-z]{3,9},?\s+[A-Za-z]{3,9}\s+\d{1,2}(?:,?\s+\d{2,4})?(?:\s+(?:at|by)\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /(?:due|deadline|available until|available)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2}(?:,?\s+\d{2,4})?(?:\s+(?:at|by)\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /([A-Za-z]{3,9},\s+[A-Za-z]{3,9}\s+\d{1,2}(?:\s+by\s+\d{1,2}\s*:\s*\d{2}\s*(?:AM|PM)?)?)/i,
    /([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i
  ];

  for (const re of patterns) {
    const m = compact.match(re);
    if (!m) continue;
    const parsed = parseCandidate(m[1]);
    if (parsed) return parsed;
  }
  return null;
}

function normalizeForCalendar(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCourseCodeFromTitle(courseTitle) {
  const m = String(courseTitle || '').toUpperCase().match(/\b(CIT300|CIT302|CIT350|CRIM330)\b/);
  return m ? m[1] : null;
}

async function loadCalendarOverrides() {
  if (!calendarOverridesPath) return;
  try {
    const raw = await fs.readFile(calendarOverridesPath, 'utf8');
    const parsed = JSON.parse(raw);

    const exactByCourse = new Map();
    for (const entry of parsed.exact || []) {
      if (!entry?.course || !entry?.title || !entry?.dueAt) continue;
      const course = String(entry.course).toUpperCase();
      const list = exactByCourse.get(course) || [];
      list.push({
        titleNorm: normalizeForCalendar(entry.title),
        dueAt: entry.dueAt
      });
      exactByCourse.set(course, list);
    }

    const patternsByCourse = new Map();
    for (const entry of parsed.patterns || []) {
      if (!entry?.course || !entry?.pattern || !entry?.dueAt) continue;
      const course = String(entry.course).toUpperCase();
      const list = patternsByCourse.get(course) || [];
      try {
        list.push({ re: new RegExp(entry.pattern, 'i'), dueAt: entry.dueAt });
      } catch {
        // Skip invalid regex entries.
      }
      patternsByCourse.set(course, list);
    }

    calendarOverrides = { exactByCourse, patternsByCourse };
  } catch {
    calendarOverrides = null;
  }
}

function getCalendarDueOverride(courseTitle, assignmentTitle) {
  if (!calendarOverrides) return null;
  const courseCode = getCourseCodeFromTitle(courseTitle);
  if (!courseCode) return null;

  const titleText = String(assignmentTitle || '');
  const titleNorm = normalizeForCalendar(titleText);
  if (!titleNorm) return null;

  const exactList = calendarOverrides.exactByCourse.get(courseCode) || [];
  for (const item of exactList) {
    if (item.titleNorm === titleNorm || item.titleNorm.includes(titleNorm) || titleNorm.includes(item.titleNorm)) {
      return item.dueAt;
    }
  }

  const patternList = calendarOverrides.patternsByCourse.get(courseCode) || [];
  for (const item of patternList) {
    if (item.re.test(titleText)) {
      return item.dueAt;
    }
  }

  return null;
}

function scoreAssignment(item) {
  const now = Date.now();
  const dueMs = item.dueAt ? Date.parse(item.dueAt) : NaN;
  let urgencyScore = 20;

  if (!Number.isNaN(dueMs)) {
    const hoursLeft = (dueMs - now) / 36e5;
    if (hoursLeft <= 0) urgencyScore = 100;
    else if (hoursLeft <= 24) urgencyScore = 92;
    else if (hoursLeft <= 72) urgencyScore = 80;
    else if (hoursLeft <= 168) urgencyScore = 62;
    else if (hoursLeft <= 336) urgencyScore = 48;
    else urgencyScore = 34;
  }

  const t = (item.title || '').toLowerCase();
  let complexity = 10;
  if (/final|midterm|exam/.test(t)) complexity += 45;
  if (/project|portfolio/.test(t)) complexity += 35;
  if (/paper|essay/.test(t)) complexity += 25;
  if (/quiz|test/.test(t)) complexity += 15;
  if (/discussion/.test(t)) complexity += 8;

  const recommendedXp = Math.round(20 + urgencyScore * 0.8 + Math.min(100, complexity) * 0.6);

  return {
    ...item,
    urgencyScore,
    recommendedXp,
    daysUntilDue: Number.isNaN(dueMs) ? null : Math.round((dueMs - now) / 86400000)
  };
}

function shouldDropTitle(title) {
  const t = (title || '').trim();
  if (!t) return true;
  if (t.length < 4 || t.length > 240) return true;
  const blacklist = [
    /^announcements?$/i,
    /^calendar$/i,
    /^content$/i,
    /^courses?$/i,
    /^gradebook$/i,
    /^messages?$/i,
    /^groups?$/i,
    /^discussions?\d+$/i,
    /^help for current page$/i,
    /^skip to main content$/i,
    /^course status open$/i
  ];
  return blacklist.some((re) => re.test(t));
}

function normalizeForMatch(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'week', 'course', 'class', 'due']);
  return new Set(
    normalizeForMatch(text)
      .split(' ')
      .filter((x) => x.length > 2 && !stop.has(x))
  );
}

function looksAnnouncementLike(text) {
  return /announcement|posted|reminder|missing or late assignments|class announcement/i.test(text || '');
}

function looksAssignmentLike(text) {
  return /assignment|quiz|exam|test|project|homework|lab|discussion|paper|essay|submission|attempt|checkpoint/i.test(text || '');
}

function isCalendarUiNoise(text) {
  return /schedule due dates|day month today|previous month|next month|item name due date status grade|skip to main content/i.test(text || '');
}

function isRealAssignmentRecord(item) {
  const text = `${item.title || ''} ${item.sourcePage || ''} ${item.pageUrl || ''}`;
  if (shouldDropTitle(item.title || '')) return false;
  if (isCalendarUiNoise(text)) return false;
  if (looksAnnouncementLike(text)) return false;
  if ((item.link || '').startsWith('javascript:')) return false;
  return Boolean(item.dueAt || looksAssignmentLike(text));
}

function extractRequirementsFromContext(...texts) {
  const out = [];
  for (const text of texts) {
    const compact = (text || '').replace(/\s+/g, ' ').trim();
    if (!compact) continue;

    const parts = compact
      .split(/(?:\u2022|\n|;|\|)/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 6 && x.length <= 180);

    for (const part of parts) {
      if (isCalendarUiNoise(part)) continue;
      if (/skip to|course status open|help for current page/i.test(part)) continue;
      if (/must|submit|include|complete|read|watch|post|reply|assignment|quiz|exam|discussion|project|homework|rubric|instructions/i.test(part)) {
        out.push(part);
      }
    }
  }
  return uniqBy(out, (x) => normalizeForMatch(x)).slice(0, 12);
}

function correlateCalendarAssignments(calendarEvents, assignmentCandidates, courseTitle, courseUrl) {
  const events = uniqBy(calendarEvents, (x) => `${normalizeForMatch(x.title)}|${x.dueAt || ''}`);
  const candidates = uniqBy(assignmentCandidates, (x) => `${normalizeForMatch(x.title)}|${x.link || ''}|${x.dueAt || ''}`);
  const used = new Set();
  const out = [];

  for (const event of events) {
    const eventText = `${event.title || ''} ${event.context || ''}`;
    if (!event.dueAt && !looksAssignmentLike(eventText)) continue;
    if (looksAnnouncementLike(eventText)) continue;

    const eventTokens = tokenSet(event.title || '');
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < candidates.length; i += 1) {
      if (used.has(i)) continue;
      const c = candidates[i];
      const candText = `${c.title || ''} ${c.context || ''}`;
      if (looksAnnouncementLike(candText)) continue;

      let score = 0;
      const candTokens = tokenSet(c.title || '');
      for (const t of eventTokens) {
        if (candTokens.has(t)) score += 2;
      }

      const nEvent = normalizeForMatch(event.title || '');
      const nCand = normalizeForMatch(c.title || '');
      if (nEvent && nCand && (nCand.includes(nEvent) || nEvent.includes(nCand))) score += 4;

      const eventMs = event.dueAt ? Date.parse(event.dueAt) : NaN;
      const candMs = c.dueAt ? Date.parse(c.dueAt) : NaN;
      if (!Number.isNaN(eventMs) && !Number.isNaN(candMs)) {
        const hours = Math.abs(eventMs - candMs) / 36e5;
        if (hours <= 24) score += 6;
        else if (hours <= 72) score += 3;
      }

      if (looksAssignmentLike(candText)) score += 2;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const matched = bestIdx >= 0 && bestScore >= 4 ? candidates[bestIdx] : null;
    if (matched) used.add(bestIdx);

    const title = (matched?.title || event.title || '').trim();
    const joined = `${title} ${event.context || ''} ${matched?.context || ''}`;
    if (shouldDropTitle(title) || looksAnnouncementLike(joined) || isCalendarUiNoise(joined)) continue;

    out.push({
      courseTitle,
      courseUrl,
      sourcePage: event.sourcePage || matched?.sourcePage || courseUrl,
      pageUrl: event.pageUrl || matched?.pageUrl || courseUrl,
      title,
      assignmentTitle: title,
      link: matched?.link || event.link || null,
      dueAt: event.dueAt || matched?.dueAt || getCalendarDueOverride(courseTitle, title) || null,
      context: `${event.context || ''} ${matched?.context || ''}`.trim(),
      correlationScore: bestScore,
      requirements: extractRequirementsFromContext(event.context || '', matched?.context || '', title)
    });
  }

  return uniqBy(out, (x) => `${x.courseTitle}|${normalizeForMatch(x.title)}|${x.link || ''}|${x.dueAt || ''}`);
}

async function captureDebug(page, tag) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${tag}.html`), await page.content());
  await page.screenshot({ path: path.join(outDir, `${tag}.png`), fullPage: true });
}

function attachDebugConsole(page) {
  if (!debugTitleExtraction || !page) return;
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[TitleDebug]')) {
      console.log(text);
    }
  });
}

async function getAuthState(page) {
  return page.evaluate(() => {
    const href = location.href;
    const title = document.title || '';
    const bodyText = (document.body?.innerText || '').slice(0, 10000);
    const authKeywordHit =
      /sign in|log in|single sign-on|sso|username|password/i.test(bodyText) ||
      /\/auth\//i.test(href);

    const looksInApp =
      /\/ultra\/(course|stream|courses|calendar|institution-page)/i.test(href) ||
      /\/webapps\/blackboard/i.test(href) ||
      Boolean(document.querySelector('a[href*="/ultra/courses/_"], a[href*="course_id="]'));

    const looksLoggedOut = authKeywordHit && !looksInApp;
    return { href, title, looksLoggedOut, looksInApp };
  });
}

async function collectCourseLinksFromPage(page, origin, sourceLabel) {
  const raw = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a, [onclick], [data-href], [data-url], [data-course-id]'));
    return nodes.map((el) => {
      const anchor = el.tagName === 'A' ? el : el.querySelector?.('a');
      return {
        title: (el.textContent || anchor?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 260),
        hrefAttr: anchor?.getAttribute('href') || el.getAttribute?.('href') || '',
        hrefAbs: anchor?.href || '',
        dataHref: el.getAttribute?.('data-href') || '',
        dataUrl: el.getAttribute?.('data-url') || '',
        dataCourseId: el.getAttribute?.('data-course-id') || '',
        onclick: el.getAttribute?.('onclick') || ''
      };
    });
  });

  const out = [];
  for (const r of raw) {
    const onclickUrl = r.onclick
      ? (r.onclick.match(/(https?:\/\/[^'"\s)]+|\/ultra\/courses\/_[^'"\s)]+)/i)?.[0] || null)
      : null;

    const candidates = [
      r.hrefAbs,
      r.hrefAttr,
      r.dataHref,
      r.dataUrl,
      r.dataCourseId ? `/ultra/courses/${r.dataCourseId}` : null,
      onclickUrl
    ].filter(Boolean);

    for (const candidate of candidates) {
      const canonical = canonicalCourseUrl(candidate, origin);
      if (!canonical) continue;

      const title = (r.title || 'Untitled Course').replace(/\s+/g, ' ').trim();
      out.push({ title, url: canonical, source: sourceLabel });
    }
  }

  return uniqBy(out, (x) => x.url).filter((x) => /[a-z]{2,4}\d{3}/i.test(x.title) || /\(.*\)/.test(x.title));
}

function extractTermKey(title) {
  const m = (title || '').match(/\((Fa|Sp|Su|Wi)\d{2}\)/i);
  return m ? m[0].toLowerCase() : null;
}

function isAcademicCourseTitle(title) {
  const t = (title || '').trim();
  return /^[A-Za-z]{2,4}\d{3}/.test(t) && t.includes(':');
}

function filterPreferredCourses(courses) {
  const unique = uniqBy(courses, (x) => x.url);
  const academic = unique.filter((x) => isAcademicCourseTitle(x.title));
  if (!academic.length) return unique;

  const termCounts = new Map();
  for (const course of academic) {
    const term = extractTermKey(course.title);
    if (!term) continue;
    termCounts.set(term, (termCounts.get(term) || 0) + 1);
  }

  if (!termCounts.size) {
    return academic;
  }

  const primaryTerm = [...termCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return academic.filter((x) => extractTermKey(x.title) === primaryTerm);
}

async function collectCourseLinks(page, origin) {
  const currentOnly = await collectCourseLinksFromPage(page, origin, `current:${page.url()}`);
  if (currentOnly.length) {
    return filterPreferredCourses(currentOnly).sort((a, b) => a.title.localeCompare(b.title));
  }

  const all = [];
  const probeUrls = [
    `${origin}/ultra/stream`,
    `${origin}/ultra/course`,
    `${origin}/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1`
  ];

  for (const probe of probeUrls) {
    try {
      await page.goto(probe, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1400);
      all.push(...(await collectCourseLinksFromPage(page, origin, `probe:${probe}`)));
    } catch {
      // Continue.
    }
  }

  return filterPreferredCourses(all).sort((a, b) => a.title.localeCompare(b.title));
}

function buildCoursePages(courseUrl, origin) {
  const courseId = extractCourseId(courseUrl);
  if (!courseId) return [courseUrl];

  return uniqBy([
    `${origin}/ultra/courses/${courseId}/outline`,
    `${origin}/ultra/courses/${courseId}/calendar`,
    `${origin}/ultra/courses/${courseId}/grades`,
    `${origin}/ultra/courses/${courseId}/gradebook`,
    `${origin}/ultra/courses/${courseId}/announcements`,
    `${origin}/ultra/courses/${courseId}/activity`,
    `${origin}/ultra/courses/${courseId}/engagement`
  ], (x) => x);
}

async function scrapeCourseCalendarEvents(page, meta) {
  const raw = await page.evaluate((m) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const stripGenericWords = (s) =>
      clean((s || '').replace(/\b(Assignment|Test|Discussion|Content|Due|Points|Status)\b/gi, ' '));
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isGeneric = (s) => /^(assignment|test|discussion|content|due|points|status)$/i.test(clean(s));
    let debugCount = 0;

    function getBestTitle(row) {
      const candidates = [];
      let winner = 'none';
      let title = '';

      const links = Array.from(row.querySelectorAll('a[href]')).filter((a) => isVisible(a));
      const keywordLink = links.find((a) =>
        /(assignment|content|launch|attempt|detail|view)/i.test(a.getAttribute('href') || a.href || '')
      );
      if (keywordLink) {
        const t = clean(keywordLink.textContent || keywordLink.getAttribute('aria-label') || '');
        candidates.push({ source: 'primary-link-keyword', value: t });
        if (t && !isGeneric(t)) {
          title = t;
          winner = 'primary-link-keyword';
        }
      }

      if (!title) {
        const roleLinks = links.filter((a) => (a.getAttribute('role') || '').toLowerCase() === 'link');
        let largest = null;
        let largestLen = -1;
        for (const a of roleLinks) {
          const t = clean(a.textContent || a.getAttribute('aria-label') || '');
          if (t.length > largestLen) {
            largest = t;
            largestLen = t.length;
          }
        }
        candidates.push({ source: 'role-link-largest', value: largest || '' });
        if (largest && !isGeneric(largest)) {
          title = largest;
          winner = 'role-link-largest';
        }
      }

      if (!title) {
        const heading = Array.from(row.querySelectorAll('h1, h2, h3'))
          .find((h) => isVisible(h) && clean(h.textContent || '').length > 2 && !isGeneric(h.textContent || ''));
        const ht = heading ? clean(heading.textContent || '') : '';
        candidates.push({ source: 'heading', value: ht });
        if (ht) {
          title = ht;
          winner = 'heading';
        }
      }

      if (!title) {
        const named = Array.from(row.querySelectorAll('[data-testid], [aria-label]')).find((el) => {
          const id = (el.getAttribute('data-testid') || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          return /(title|name)/.test(id) || /(title|name)/.test(aria);
        });
        const nt = clean(named?.getAttribute('aria-label') || named?.textContent || '');
        candidates.push({ source: 'testid-aria', value: nt });
        if (nt && !isGeneric(nt)) {
          title = nt;
          winner = 'testid-aria';
        }
      }

      if (!title) {
        const firstLine = clean((row.innerText || '').split(/\n/).find((ln) => clean(ln)) || '');
        const fallback = stripGenericWords(firstLine);
        candidates.push({ source: 'fallback-first-line', value: fallback });
        if (fallback) {
          title = fallback;
          winner = 'fallback-first-line';
        }
      }

      if (m.debugTitles && debugCount < 10) {
        console.log('[TitleDebug][calendar]', { winner, candidates });
        debugCount += 1;
      }

      return title || '';
    }

    const nodes = Array.from(document.querySelectorAll('li, tr, article, section, div')).slice(0, 2000);
    const out = [];

    for (const node of nodes) {
      const text = clean((node.textContent || '').slice(0, 800));
      if (!text) continue;
      if (!/(due|deadline|assignment|quiz|exam|project|homework|discussion|lab|paper|essay|week|module|unit|chapter|[A-Za-z]{3,9}\s+\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i.test(text)) {
        continue;
      }

      const anchor = node.querySelector('a[href]');
      const title = getBestTitle(node).slice(0, 220);
      if (!title) continue;

      out.push({
        courseTitle: m.courseTitle,
        courseUrl: m.courseUrl,
        sourcePage: m.sourcePage,
        pageUrl: location.href,
        pageTitle: document.title,
        title,
        link: anchor?.href || null,
        context: text
      });
    }

    return out;
  }, meta);

  return raw
    .map((x) => ({
      ...x,
      dueAt: extractDateFromText(`${x.title} ${x.context || ''}`)
    }))
    .filter((x) => x.dueAt || looksAssignmentLike(`${x.title} ${x.context || ''}`))
    .filter((x) => !looksAnnouncementLike(`${x.title} ${x.context || ''}`))
    .filter((x) => !shouldDropTitle(x.title));
}

async function scrapePageItems(page, meta) {
  const raw = await page.evaluate((m) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const stripGenericWords = (s) =>
      clean((s || '').replace(/\b(Assignment|Test|Discussion|Content|Due|Points|Status)\b/gi, ' '));
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isGeneric = (s) => /^(assignment|test|discussion|content|due|points|status)$/i.test(clean(s));
    let debugCount = 0;

    function getBestTitle(row) {
      const candidates = [];
      let winner = 'none';
      let title = '';

      const links = Array.from(row.querySelectorAll('a[href]')).filter((a) => isVisible(a));
      const keywordLink = links.find((a) =>
        /(assignment|content|launch|attempt|detail|view)/i.test(a.getAttribute('href') || a.href || '')
      );
      if (keywordLink) {
        const t = clean(keywordLink.textContent || keywordLink.getAttribute('aria-label') || '');
        candidates.push({ source: 'primary-link-keyword', value: t });
        if (t && !isGeneric(t)) {
          title = t;
          winner = 'primary-link-keyword';
        }
      }

      if (!title) {
        const roleLinks = links.filter((a) => (a.getAttribute('role') || '').toLowerCase() === 'link');
        let largest = null;
        let largestLen = -1;
        for (const a of roleLinks) {
          const t = clean(a.textContent || a.getAttribute('aria-label') || '');
          if (t.length > largestLen) {
            largest = t;
            largestLen = t.length;
          }
        }
        candidates.push({ source: 'role-link-largest', value: largest || '' });
        if (largest && !isGeneric(largest)) {
          title = largest;
          winner = 'role-link-largest';
        }
      }

      if (!title) {
        const heading = Array.from(row.querySelectorAll('h1, h2, h3'))
          .find((h) => isVisible(h) && clean(h.textContent || '').length > 2 && !isGeneric(h.textContent || ''));
        const ht = heading ? clean(heading.textContent || '') : '';
        candidates.push({ source: 'heading', value: ht });
        if (ht) {
          title = ht;
          winner = 'heading';
        }
      }

      if (!title) {
        const named = Array.from(row.querySelectorAll('[data-testid], [aria-label]')).find((el) => {
          const id = (el.getAttribute('data-testid') || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          return /(title|name)/.test(id) || /(title|name)/.test(aria);
        });
        const nt = clean(named?.getAttribute('aria-label') || named?.textContent || '');
        candidates.push({ source: 'testid-aria', value: nt });
        if (nt && !isGeneric(nt)) {
          title = nt;
          winner = 'testid-aria';
        }
      }

      if (!title) {
        const firstLine = clean((row.innerText || '').split(/\n/).find((ln) => clean(ln)) || '');
        const fallback = stripGenericWords(firstLine);
        candidates.push({ source: 'fallback-first-line', value: fallback });
        if (fallback) {
          title = fallback;
          winner = 'fallback-first-line';
        }
      }

      if (m.debugTitles && debugCount < 10) {
        console.log('[TitleDebug][items]', { winner, candidates });
        debugCount += 1;
      }

      return title || '';
    }

    const assignmentRe = /assignment|quiz|exam|test|project|homework|lab|discussion|submission|attempt|due|deadline/i;
    const announcementRe = /announcement|posted|important|notice|reminder/i;
    const syllabusRe = /syllabus|course schedule|course outline|course information/i;

    const candidates = [];

    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const href = a.href || '';
      if (!href || !/^https?:/i.test(href)) continue;

      const container = a.closest('li, tr, article, section, div');
      const row = container || a;
      const title = getBestTitle(row) || clean(a.textContent || a.getAttribute('aria-label') || '');
      const context = clean((container?.textContent || '').slice(0, 500));
      const signature = `${title} ${context}`.trim();
      if (!signature) continue;

      let kind = null;
      if (syllabusRe.test(signature)) kind = 'syllabus';
      if (assignmentRe.test(signature)) kind = 'assignment';
      if (announcementRe.test(signature)) kind = 'announcement';
      if (!kind) continue;

      candidates.push({
        kind,
        title,
        link: href,
        context,
        pageUrl: location.href,
        pageTitle: document.title,
        courseTitle: m.courseTitle,
        courseUrl: m.courseUrl,
        sourcePage: m.sourcePage
      });
    }

    const blocks = Array.from(document.querySelectorAll('li, tr, article, section')).slice(0, 1200);
    for (const block of blocks) {
      const text = clean((block.textContent || '').slice(0, 600));
      if (!text) continue;
      const bestTitle = getBestTitle(block).slice(0, 200);
      if (!bestTitle) continue;

      const link = block.querySelector('a[href]')?.href || null;
      let kind = null;
      if (syllabusRe.test(text)) kind = 'syllabus';
      if (assignmentRe.test(text)) kind = 'assignment';
      if (announcementRe.test(text)) kind = 'announcement';
      if (!kind) continue;

      candidates.push({
        kind,
        title: bestTitle,
        link,
        context: text,
        pageUrl: location.href,
        pageTitle: document.title,
        courseTitle: m.courseTitle,
        courseUrl: m.courseUrl,
        sourcePage: m.sourcePage
      });
    }

    return candidates;
  }, meta);

  const assignments = [];
  const announcements = [];
  const syllabi = [];

  for (const item of raw) {
    const title = (item.title || '').replace(/\s+/g, ' ').trim();
    if (shouldDropTitle(title)) continue;
    const signature = `${title} ${item.context || ''}`.toLowerCase();
    const fromAnnouncementsPage = /\/announcements(\/|$)/i.test(item.sourcePage || item.pageUrl || '');
    const looksAnnouncementLike = /announcement|posted|class announcement|all,\s|reminder|missing or late assignments/i.test(signature);

    const cleaned = {
      courseTitle: item.courseTitle,
      courseUrl: item.courseUrl,
      sourcePage: item.sourcePage,
      pageUrl: item.pageUrl,
      title,
      link: item.link,
      context: item.context || '',
      dueAt: extractDateFromText(`${title} ${item.context || ''}`) || getCalendarDueOverride(item.courseTitle, title)
    };

    const effectiveKind = fromAnnouncementsPage && item.kind === 'assignment' ? 'announcement' : item.kind;
    if (effectiveKind === 'assignment' && !looksAnnouncementLike) assignments.push(cleaned);
    if (effectiveKind === 'announcement' || (effectiveKind === 'assignment' && looksAnnouncementLike)) {
      announcements.push({
        courseTitle: item.courseTitle,
        courseUrl: item.courseUrl,
        sourcePage: item.sourcePage,
        pageUrl: item.pageUrl,
        title,
        link: item.link,
        context: item.context || '',
        postedAt: extractDateFromText(`${title} ${item.context || ''}`)
      });
    }
    if (item.kind === 'syllabus') {
      syllabi.push({
        courseTitle: item.courseTitle,
        courseUrl: item.courseUrl,
        sourcePage: item.sourcePage,
        pageUrl: item.pageUrl,
        title,
        link: item.link
      });
    }
  }

  return {
    assignments,
    announcements,
    syllabi,
    pageMeta: {
      url: page.url(),
      title: await page.title()
    }
  };
}

async function enrichAssignmentDueDates(browserContext, assignments, origin) {
  const out = [];
  const dueByLink = new Map();
  let scannedLinks = 0;
  const MAX_LINK_SCANS = 80;

  for (const item of assignments) {
    if (item.dueAt || !item.link || !/^https?:/i.test(item.link)) {
      out.push(item);
      continue;
    }

    let inferredDue = dueByLink.get(item.link);
    if (inferredDue === undefined) {
      inferredDue = null;
      if (scannedLinks < MAX_LINK_SCANS) {
        try {
          const url = new URL(item.link);
          if (url.origin === origin) {
            const p = await browserContext.newPage();
            attachDebugConsole(p);
            await p.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await p.waitForTimeout(700);

            const detailText = await p.evaluate(() => {
              const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
              const bits = [];
              const selectors = [
                '[aria-label*="due" i]',
                '[data-testid*="due" i]',
                'time',
                'dt',
                'dd',
                '.due-date',
                '.deadline'
              ];
              for (const selector of selectors) {
                for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 60)) {
                  const txt = clean(el.getAttribute?.('aria-label') || el.textContent || '');
                  if (txt) bits.push(txt);
                }
              }
              bits.push(clean((document.body?.innerText || '').slice(0, 3500)));
              return bits.join(' | ');
            });

            inferredDue = extractDateFromText(detailText);
            scannedLinks += 1;
            await p.close();
          }
        } catch {
          // Continue.
        }
      }
      dueByLink.set(item.link, inferredDue);
    }

    out.push({
      ...item,
      dueAt: item.dueAt || inferredDue || null
    });
  }

  return out;
}

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 900 }
});

const page = context.pages()[0] || await context.newPage();
attachDebugConsole(page);
await loadCalendarOverrides();
await page.goto(base, { waitUntil: 'domcontentloaded' });

console.log('\nLog into Blackboard and open your real course dashboard/list page.');
await ask('When it is visible, press ENTER to run full scrape... ');

await fs.mkdir(outDir, { recursive: true });

const identity = await page.evaluate(() => ({
  url: location.href,
  origin: location.origin,
  title: document.title
}));
await fs.writeFile(path.join(outDir, 'session.json'), JSON.stringify(identity, null, 2));

const auth = await getAuthState(page);
await fs.writeFile(path.join(outDir, 'auth.state.json'), JSON.stringify(auth, null, 2));

if (auth.looksLoggedOut) {
  await captureDebug(page, 'debug_logged_out');
  throw new Error('Login not detected. Stay authenticated before pressing ENTER.');
}

let apiCourses = null;
try {
  apiCourses = await page.evaluate(async () => {
    const u = new URL('/learn/api/public/v1/courses?limit=500', location.origin).toString();
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  });
} catch (e) {
  apiCourses = { ok: false, error: String(e) };
}
await fs.writeFile(path.join(outDir, 'courses.api.json'), JSON.stringify(apiCourses, null, 2));

const courses = await collectCourseLinks(page, identity.origin);
await fs.writeFile(path.join(outDir, 'courses.dom.json'), JSON.stringify(courses, null, 2));

if (!courses.length) {
  await captureDebug(page, 'debug_no_courses');
  throw new Error('No Blackboard course links found. See debug_no_courses.* files.');
}

const allAssignments = [];
const allAnnouncements = [];
const allSyllabi = [];
const crawlLog = [];
const courseBuckets = new Map();

for (const course of courses.slice(0, 200)) {
  courseBuckets.set(course.url, {
    courseTitle: course.title,
    courseUrl: course.url,
    calendarEvents: [],
    assignmentCandidates: [],
    announcements: [],
    syllabi: []
  });

  const pages = buildCoursePages(course.url, identity.origin);

  for (const sourcePage of pages) {
    const p = await context.newPage();
    attachDebugConsole(p);
    try {
      await p.goto(sourcePage, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(900);

      const bucket = courseBuckets.get(course.url);

      if (/\/calendar(\/|$)/i.test(sourcePage)) {
        const calendarEvents = await scrapeCourseCalendarEvents(p, {
          courseTitle: course.title,
          courseUrl: course.url,
          sourcePage,
          debugTitles: debugTitleExtraction
        });
        bucket.calendarEvents.push(...calendarEvents);
      }

      const result = await scrapePageItems(p, {
        courseTitle: course.title,
        courseUrl: course.url,
        sourcePage,
        debugTitles: debugTitleExtraction
      });

      bucket.assignmentCandidates.push(...result.assignments);
      bucket.announcements.push(...result.announcements);
      bucket.syllabi.push(...result.syllabi);

      crawlLog.push({
        courseTitle: course.title,
        courseUrl: course.url,
        sourcePage,
        pageUrl: result.pageMeta.url,
        pageTitle: result.pageMeta.title,
        assignmentsFound: result.assignments.length,
        announcementsFound: result.announcements.length,
        syllabiFound: result.syllabi.length,
        calendarEventsFound: /\/calendar(\/|$)/i.test(sourcePage) ? bucket.calendarEvents.length : 0
      });
    } catch (err) {
      crawlLog.push({
        courseTitle: course.title,
        courseUrl: course.url,
        sourcePage,
        error: String(err)
      });
    } finally {
      await p.close();
    }
  }
}

for (const bucket of courseBuckets.values()) {
  const correlated = correlateCalendarAssignments(
    bucket.calendarEvents,
    bucket.assignmentCandidates,
    bucket.courseTitle,
    bucket.courseUrl
  );

  const directAssignments = bucket.assignmentCandidates.map((item) => ({
    ...item,
    dueAt: item.dueAt || getCalendarDueOverride(item.courseTitle, item.title),
    assignmentTitle: item.assignmentTitle || item.title,
    requirements: item.requirements || extractRequirementsFromContext(item.title || '', item.context || '', item.sourcePage || '')
  }));

  allAssignments.push(...correlated, ...directAssignments);
  allAnnouncements.push(...bucket.announcements);
  allSyllabi.push(...bucket.syllabi);
}

for (const globalPath of ['/ultra/calendar', '/ultra/stream']) {
  const p = await context.newPage();
  attachDebugConsole(p);
  try {
    const url = `${identity.origin}${globalPath}`;
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(1200);

    const result = await scrapePageItems(p, {
      courseTitle: 'Global Blackboard',
      courseUrl: url,
      sourcePage: url,
      debugTitles: debugTitleExtraction
    });

    allAnnouncements.push(...result.announcements);
    allSyllabi.push(...result.syllabi);

    crawlLog.push({
      courseTitle: 'Global Blackboard',
      courseUrl: url,
      sourcePage: url,
      pageUrl: result.pageMeta.url,
      pageTitle: result.pageMeta.title,
      assignmentsFound: 0,
      announcementsFound: result.announcements.length,
      syllabiFound: result.syllabi.length
    });
  } catch (err) {
    crawlLog.push({ sourcePage: `${identity.origin}${globalPath}`, error: String(err) });
  } finally {
    await p.close();
  }
}

const enrichedAllAssignments = await enrichAssignmentDueDates(context, allAssignments, identity.origin);

const uniqueAssignments = uniqBy(
  enrichedAllAssignments
    .map((x) => ({
      ...x,
      dueAt: x.dueAt
        || extractDateFromText(`${x.title || ''} ${x.context || ''} ${x.sourcePage || ''}`)
        || getCalendarDueOverride(x.courseTitle, x.title)
    }))
    .filter((x) => isRealAssignmentRecord(x))
    .filter((x) => {
      if (!x.dueAt) return true;
      const dueMs = Date.parse(x.dueAt);
      return Number.isNaN(dueMs) || dueMs >= Date.now();
    })
    .map(scoreAssignment),
  (x) => `${x.courseTitle}|${x.title}|${x.link || ''}|${x.dueAt || ''}`
);

const uniqueAnnouncements = uniqBy(
  allAnnouncements.filter((x) => !shouldDropTitle(x.title)),
  (x) => `${x.courseTitle}|${x.title}|${x.link || ''}|${x.postedAt || ''}`
);

const uniqueSyllabi = uniqBy(
  allSyllabi.filter((x) => !shouldDropTitle(x.title)),
  (x) => `${x.courseTitle}|${x.title}|${x.link || ''}`
);

await fs.writeFile(path.join(outDir, 'crawl.log.json'), JSON.stringify(crawlLog, null, 2));
await fs.writeFile(path.join(outDir, 'assignments.dom.json'), JSON.stringify(uniqueAssignments, null, 2));
await fs.writeFile(path.join(outDir, 'announcements.dom.json'), JSON.stringify(uniqueAnnouncements, null, 2));
await fs.writeFile(path.join(outDir, 'syllabus.dom.json'), JSON.stringify(uniqueSyllabi, null, 2));

if (!uniqueAssignments.length && !uniqueAnnouncements.length) {
  await captureDebug(page, 'debug_no_items');
  console.warn('Warning: no assignment or announcement items extracted. See debug_no_items.*');
}

console.log(`\nDone. Files saved to: ${outDir}`);
console.log('- session.json');
console.log('- auth.state.json');
console.log('- courses.api.json');
console.log('- courses.dom.json');
console.log('- crawl.log.json');
console.log('- assignments.dom.json');
console.log('- announcements.dom.json');
console.log('- syllabus.dom.json');

await context.close();
JS_SCRAPE

cat > generate_summary.mjs <<'JS_SUMMARY'
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.env.OUT_DIR;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8'));
  } catch {
    return fallback;
  }
}

const session = readJson('session.json', {});
const auth = readJson('auth.state.json', {});
const courses = readJson('courses.dom.json', []);
const assignmentsRaw = readJson('assignments.dom.json', []);
const announcementsRaw = readJson('announcements.dom.json', []);
const syllabi = readJson('syllabus.dom.json', []);
const crawl = readJson('crawl.log.json', []);

const now = Date.now();

function looksLikeAnnouncementRecord(item) {
  const text = `${item.title || ''} ${item.sourcePage || ''} ${item.pageUrl || ''}`.toLowerCase();
  return /\/announcements(\/|$)|announcement|class announcement|missing or late assignments|posted/i.test(text);
}

function looksLikeCalendarUiNoise(item) {
  const text = `${item.title || ''} ${item.sourcePage || ''} ${item.pageUrl || ''}`.toLowerCase();
  if (/schedule due dates|day month today|previous month|next month|item name due date status grade|skip to main content/.test(text)) return true;
  if ((item.link || '').toLowerCase().startsWith('javascript:')) return true;
  return false;
}

function inferDateFromText(text) {
  if (!text) return null;
  const compact = String(text).replace(/\s+/g, ' ').trim();
  const currentYear = new Date().getFullYear();

  const parseCandidate = (candidate) => {
    const cleaned = candidate
      .replace(/\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/gi, '')
      .replace(/\bby\b/gi, ' ')
      .replace(/(\d{1,2})\s*:\s*(\d{2})/g, '$1:$2')
      .replace(/^([A-Za-z]{3,9}),\s+([A-Za-z]{3,9}\s+\d{1,2})/i, '$2')
      .replace(/\s+/g, ' ')
      .trim();

    const hasYear = /\b(19|20)\d{2}\b/.test(cleaned);
    if (hasYear) {
      const direct = Date.parse(cleaned);
      if (!Number.isNaN(direct)) return new Date(direct).toISOString();
    }

    const noYear = cleaned.match(/^([A-Za-z]{3,9}\s+\d{1,2})(?:\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?))?$/i);
    if (noYear) {
      const withYear = `${noYear[1]}, ${currentYear}${noYear[2] ? ` ${noYear[2]}` : ''}`;
      const parsed = Date.parse(withYear);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }

    const fallback = Date.parse(cleaned);
    if (!Number.isNaN(fallback)) return new Date(fallback).toISOString();

    return null;
  };

  const patterns = [
    /(?:due|deadline|available until|available)\s*[:\-]?\s*([A-Za-z]{3,9},?\s+[A-Za-z]{3,9}\s+\d{1,2}(?:,?\s+\d{2,4})?(?:\s+(?:at|by)\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /(?:due|deadline|available until|available)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2}(?:,?\s+\d{2,4})?(?:\s+(?:at|by)\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /([A-Za-z]{3,9},\s+[A-Za-z]{3,9}\s+\d{1,2}(?:\s+by\s+\d{1,2}\s*:\s*\d{2}\s*(?:AM|PM)?)?)/i,
    /([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i
  ];

  for (const re of patterns) {
    const m = compact.match(re);
    if (!m) continue;
    const parsed = parseCandidate(m[1]);
    if (parsed) return parsed;
  }
  return null;
}

const reassignedAnnouncements = assignmentsRaw.filter(looksLikeAnnouncementRecord).map((a) => ({
  courseTitle: a.courseTitle,
  courseUrl: a.courseUrl,
  sourcePage: a.sourcePage,
  pageUrl: a.pageUrl,
  title: a.title,
  link: a.link,
  postedAt: inferDateFromText(`${a.title || ''} ${a.sourcePage || ''}`)
}));

const assignments = assignmentsRaw.filter((a) => {
  if (looksLikeAnnouncementRecord(a) || looksLikeCalendarUiNoise(a)) return false;
  const dueAt = a.dueAt || inferDateFromText(`${a.title || ''} ${a.context || ''} ${a.sourcePage || ''}`);
  if (!dueAt) return true;
  const dueMs = Date.parse(dueAt);
  return Number.isNaN(dueMs) || dueMs >= now;
});
const announcements = [...announcementsRaw, ...reassignedAnnouncements];

const enrichedAssignments = assignments.map((a) => {
  const inferredDueAt = a.dueAt || inferDateFromText(`${a.title || ''} ${a.context || ''} ${a.sourcePage || ''}`);
  const dueMs = inferredDueAt ? Date.parse(inferredDueAt) : NaN;
  const days = Number.isNaN(dueMs) ? null : Math.ceil((dueMs - now) / 86400000);
  let status = 'No due date';
  if (days !== null) {
    if (days < 0) status = 'Overdue';
    else if (days <= 2) status = 'Due soon';
    else if (days <= 7) status = 'This week';
    else status = 'Upcoming';
  }
  return {
    ...a,
    assignmentTitle: a.assignmentTitle || a.title || '',
    requirements: Array.isArray(a.requirements) ? a.requirements : extractRequirementsFromContext(a.title || '', a.context || ''),
    dueAt: inferredDueAt,
    daysUntilDue: days,
    status
  };
});

const sortedByDue = [...enrichedAssignments].sort((a, b) => {
  const ad = a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER;
  const bd = b.dueAt ? Date.parse(b.dueAt) : Number.MAX_SAFE_INTEGER;
  return ad - bd;
});

const overdue = sortedByDue.filter((a) => a.status === 'Overdue');
const dueSoon = sortedByDue.filter((a) => a.status === 'Due soon' || a.status === 'This week');
const noDue = sortedByDue.filter((a) => a.status === 'No due date');

const courseMap = new Map();
for (const c of courses) {
    courseMap.set(c.title, {
      courseTitle: c.title,
      courseUrl: c.url,
      assignmentsTotal: 0,
      overdue: 0,
      dueSoon: 0,
      noDue: 0,
      announcements: 0,
      syllabi: 0
    });
}

for (const a of enrichedAssignments) {
  const key = a.courseTitle;
  if (!courseMap.has(key)) {
    courseMap.set(key, {
      courseTitle: key,
      courseUrl: a.courseUrl || '',
      assignmentsTotal: 0,
      overdue: 0,
      dueSoon: 0,
      noDue: 0,
      announcements: 0,
      syllabi: 0
    });
  }
  const c = courseMap.get(key);
  c.assignmentsTotal += 1;
  if (a.status === 'Overdue') c.overdue += 1;
  if (a.status === 'Due soon' || a.status === 'This week') c.dueSoon += 1;
  if (a.status === 'No due date') c.noDue += 1;
}

for (const n of announcements) {
  const key = n.courseTitle;
  if (!courseMap.has(key)) {
    courseMap.set(key, {
      courseTitle: key,
      courseUrl: n.courseUrl || '',
      assignmentsTotal: 0,
      overdue: 0,
      dueSoon: 0,
      noDue: 0,
      announcements: 0,
      syllabi: 0
    });
  }
  courseMap.get(key).announcements += 1;
}

for (const s of syllabi) {
  const key = s.courseTitle;
  if (!courseMap.has(key)) {
    courseMap.set(key, {
      courseTitle: key,
      courseUrl: s.courseUrl || '',
      assignmentsTotal: 0,
      overdue: 0,
      dueSoon: 0,
      noDue: 0,
      announcements: 0,
      syllabi: 0
    });
  }
  courseMap.get(key).syllabi += 1;
}

const courseRows = Array.from(courseMap.values()).sort((a, b) => {
  const aRisk = a.overdue * 4 + a.dueSoon * 2 + a.noDue;
  const bRisk = b.overdue * 4 + b.dueSoon * 2 + b.noDue;
  return bRisk - aRisk || a.courseTitle.localeCompare(b.courseTitle);
});

const latestAnnouncements = [...announcements]
  .sort((a, b) => {
    const ad = a.postedAt ? Date.parse(a.postedAt) : 0;
    const bd = b.postedAt ? Date.parse(b.postedAt) : 0;
    return bd - ad;
  })
  .slice(0, 50);

const crawlErrors = crawl.filter((x) => x.error).length;
const dueCoverage = enrichedAssignments.length
  ? Math.round((enrichedAssignments.filter((x) => x.dueAt).length / enrichedAssignments.length) * 100)
  : 0;

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(iso) {
  if (!iso) return '<span class="muted">-</span>';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return esc(d.toLocaleString());
}

function fmtDays(d) {
  if (d === null || d === undefined) return '<span class="muted">-</span>';
  if (d < 0) return `${Math.abs(d)}d late`;
  if (d === 0) return 'today';
  return `${d}d`;
}

function badge(status) {
  const cls = status === 'Overdue'
    ? 'b-overdue'
    : status === 'Due soon'
      ? 'b-soon'
      : status === 'This week'
        ? 'b-week'
        : status === 'Upcoming'
          ? 'b-up'
          : 'b-none';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function link(url, label) {
  if (!url) return '<span class="muted">-</span>';
  return `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label || url)}</a>`;
}

function makeTable(headers, rows) {
  if (!rows.length) return '<div class="empty">No items.</div>';
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

const immediateActionAssignments = sortedByDue.filter((a) =>
  a.daysUntilDue !== null && a.daysUntilDue >= 0 && a.daysUntilDue <= 7
);

const urgentRows = immediateActionAssignments.slice(0, 80).map((a) =>
  `<tr><td>${esc(a.courseTitle)}</td><td>${link(a.link, a.assignmentTitle || a.title)}</td><td>${esc((a.requirements || []).slice(0, 3).join(' ; ') || '-')}</td><td>${fmtDate(a.dueAt)}</td><td>${fmtDays(a.daysUntilDue)}</td><td>${badge(a.status)}</td><td>${esc(a.urgencyScore ?? '-')}</td><td>${esc(a.recommendedXp ?? '-')}</td></tr>`
);

const timelineRows = sortedByDue.slice(0, 200).map((a) =>
  `<tr><td>${fmtDate(a.dueAt)}</td><td>${fmtDays(a.daysUntilDue)}</td><td>${badge(a.status)}</td><td>${esc(a.courseTitle)}</td><td>${link(a.link, a.assignmentTitle || a.title)}</td><td>${esc((a.requirements || []).slice(0, 2).join(' ; ') || '-')}</td><td>${esc(a.urgencyScore ?? '-')}</td></tr>`
);

const courseSummaryRows = courseRows.map((c) =>
  `<tr><td>${link(c.courseUrl, c.courseTitle)}</td><td>${c.assignmentsTotal}</td><td>${c.overdue}</td><td>${c.dueSoon}</td><td>${c.noDue}</td><td>${c.announcements}</td><td>${c.syllabi}</td></tr>`
);

const announcementRows = latestAnnouncements.map((n) =>
  `<tr><td>${esc(n.courseTitle)}</td><td>${link(n.link, n.title)}</td><td>${fmtDate(n.postedAt)}</td></tr>`
);

const noDueRows = noDue.slice(0, 120).map((a) =>
  `<tr><td>${esc(a.courseTitle)}</td><td>${link(a.link, a.assignmentTitle || a.title)}</td><td>${esc((a.requirements || []).slice(0, 3).join(' ; ') || '-')}</td><td>${esc(a.sourcePage || '-')}</td></tr>`
);

const syllabusRows = syllabi.slice(0, 200).map((s) =>
  `<tr><td>${esc(s.courseTitle)}</td><td>${link(s.link, s.title)}</td><td>${esc(s.sourcePage || '-')}</td></tr>`
);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Blackboard Reader's Digest</title>
  <style>
    :root {
      --bg: #f3f6fa;
      --panel: #fff;
      --text: #132030;
      --muted: #617385;
      --line: #d9e3ee;
      --accent: #0a5ea8;
      --danger: #c23a2b;
      --warn: #b37300;
      --ok: #2f7f4f;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px; background: linear-gradient(160deg, #e8eef7, var(--bg)); color: var(--text); font: 14px/1.45 "Segoe UI", Tahoma, Arial, sans-serif; }
    .wrap { max-width: 1280px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 30px; }
    h2 { margin: 0 0 10px; font-size: 18px; }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 10px; margin: 12px 0 16px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .value { font-size: 26px; font-weight: 700; margin-top: 3px; }
    .sections { display: grid; grid-template-columns: 1.25fr 1fr; gap: 12px; }
    .full { margin-top: 12px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 7px 6px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; color: var(--muted); }
    tr:last-child td { border-bottom: none; }
    .empty { padding: 10px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); }
    .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; border: 1px solid var(--line); }
    .b-overdue { color: var(--danger); border-color: #f2b7b0; background: #fff0ee; }
    .b-soon { color: var(--warn); border-color: #f2d49d; background: #fff7e9; }
    .b-week { color: #7a6000; border-color: #eadf9f; background: #fffde8; }
    .b-up { color: var(--ok); border-color: #bde2cb; background: #edf9f2; }
    .b-none { color: var(--muted); background: #f4f7fb; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 980px) {
      .sections { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Blackboard Reader's Digest</h1>
    <div class="muted">Generated ${esc(new Date().toLocaleString())} | ${esc(session.title || '')} | ${esc(session.url || '')}</div>

    <div class="grid">
      <div class="card"><div class="label">Courses</div><div class="value">${courses.length}</div></div>
      <div class="card"><div class="label">Assignments</div><div class="value">${enrichedAssignments.length}</div></div>
      <div class="card"><div class="label">Overdue</div><div class="value">${overdue.length}</div></div>
      <div class="card"><div class="label">Due This Week</div><div class="value">${dueSoon.length}</div></div>
      <div class="card"><div class="label">No Due Date</div><div class="value">${noDue.length}</div></div>
      <div class="card"><div class="label">Announcements</div><div class="value">${announcements.length}</div></div>
      <div class="card"><div class="label">Syllabus Items</div><div class="value">${syllabi.length}</div></div>
      <div class="card"><div class="label">Due-Date Coverage</div><div class="value">${dueCoverage}%</div></div>
      <div class="card"><div class="label">Crawl Errors</div><div class="value">${crawlErrors}</div></div>
    </div>

    <div class="sections">
      <div class="panel">
        <h2>Immediate Action</h2>
        ${makeTable(['Course', 'Assignment Title', 'Requirements', 'Due', 'ETA', 'Status', 'Urgency', 'XP'], urgentRows)}
      </div>
      <div class="panel">
        <h2>Course Risk Rollup</h2>
        ${makeTable(['Course', 'Assignments', 'Overdue', 'Due Soon', 'No Due', 'Announcements', 'Syllabus'], courseSummaryRows)}
      </div>
    </div>

    <div class="panel full">
      <h2>Assignment Timeline (All)</h2>
      ${makeTable(['Due', 'ETA', 'Status', 'Course', 'Assignment Title', 'Requirements', 'Urgency'], timelineRows)}
    </div>

    <div class="sections full">
      <div class="panel">
        <h2>Recent Announcements</h2>
        ${makeTable(['Course', 'Announcement', 'Posted'], announcementRows)}
      </div>
      <div class="panel">
        <h2>Assignments Missing Due Dates</h2>
        ${makeTable(['Course', 'Assignment Title', 'Requirements', 'Source Page'], noDueRows)}
      </div>
    </div>

    <div class="panel full">
      <h2>Syllabus Quick Access</h2>
      ${makeTable(['Course', 'Syllabus Item', 'Source Page'], syllabusRows)}
    </div>

    <div class="panel full">
      <h2>Data Quality Notes</h2>
      <ul>
        <li>Auth page: ${esc(auth.href || '-')} (${auth.looksLoggedOut ? 'logged-out-like' : 'authenticated-like'})</li>
        <li>If counts still look low, open each course once in Blackboard UI and rerun. Ultra often lazy-loads content per course after first visit.</li>
        <li>Crawl details are in <code>crawl.log.json</code> for page-level extraction counts.</li>
      </ul>
    </div>
  </div>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'summary.html'), html);
console.log('Summary written:', path.join(outDir, 'summary.html'));
JS_SUMMARY

BLACKBOARD_BASE_URL="$BLACKBOARD_BASE_URL" OUT_DIR="$OUT_DIR" PROFILE_DIR="$PROFILE_DIR" DEBUG_TITLE_EXTRACTION="$DEBUG_TITLE_EXTRACTION" CALENDAR_OVERRIDES="$CALENDAR_OVERRIDES" node scrape_blackboard.mjs
OUT_DIR="$OUT_DIR" node generate_summary.mjs
open -a "Google Chrome" "$OUT_DIR/summary.html"
