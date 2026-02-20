'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return;
  }

  if (message.type === 'SCAN_PAGE') {
    const pageType = 'blackboard';
    const debugTitles = Boolean(message.debugTitles);
    console.log('Detected pageType:', pageType);

    const extraction = getExtractionContext();
    const assignmentPage = extractAssignmentPageData(extraction.doc);
    if (assignmentPage) {
      const id = makeId(location.href, assignmentPage.assignmentTitle, assignmentPage.dueAt);
      const typeGuess = guessAssignmentType(assignmentPage.assignmentTitle);
      console.log('Assignments extracted:', 1);
      sendResponse({
        assignments: [
          {
            id,
            title: assignmentPage.assignmentTitle,
            dueAt: assignmentPage.dueAt,
            url: location.href,
            course: assignmentPage.courseName,
            scannedAt: new Date().toISOString(),
            typeGuess,
            details: assignmentPage,
            extractedFrom: extraction.source
          }
        ],
        assignmentPage,
        extractedFrom: extraction.source,
        pageType
      });
      return;
    }

    const assignments = mergeAssignmentResults(
      extractAssignmentsFromPage(extraction.doc),
      extractCourseContentPage(extraction.doc),
      extractQuizzesTestsListPage(extraction.doc)
    );
    console.log('Assignments extracted:', assignments.length);
    sendResponse({ assignments, pageType });
    return;
  }

  if (message.type === 'EXTRACT_ASSIGNMENT_PAGE') {
    const extraction = getExtractionContext();
    sendResponse({
      assignmentPage: extractAssignmentPageData(extraction.doc),
      extractedFrom: extraction.source
    });
    return;
  }

  if (message.type === 'GET_COURSE_LINKS') {
    const extraction = getExtractionContext();
    const courseLinks = extractCourseLinks(extraction.doc);
    sendResponse({ courseLinks });
  }
});

function getExtractionContext() {
  const iframes = Array.from(document.querySelectorAll('iframe'));
  if (!iframes.length) {
    return { doc: document, source: 'top' };
  }

  let bestDoc = null;
  let bestScore = -1;

  for (const iframe of iframes) {
    let score = 0;
    const meta = `${iframe.title || ''} ${iframe.name || ''} ${iframe.id || ''} ${iframe.src || ''}`.toLowerCase();
    if (/assignment|content|launch|attempt|detail|view|course|blackboard|learn|instructions|rubric/.test(meta)) {
      score += 7;
    }

    const rect = iframe.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area > 450000) score += 7;
    else if (area > 180000) score += 5;
    else if (area > 60000) score += 3;

    if (rect.height > 550) score += 2;

    let frameDoc = null;
    try {
      frameDoc = iframe.contentDocument || iframe.contentWindow?.document || null;
    } catch (_error) {
      frameDoc = null;
    }
    if (!frameDoc || !frameDoc.body) continue;

    const text = normalizeText(frameDoc.body.innerText || '');
    if (text.length > 400) score += 3;
    if (/(assignment|instructions|due|rubric|points|submission)/i.test(text)) score += 6;
    if (frameDoc.querySelector('main, [role="main"], h1, h2, table, ul, ol')) score += 2;

    if (score > bestScore) {
      bestScore = score;
      bestDoc = frameDoc;
    }
  }

  if (bestDoc) {
    return { doc: bestDoc, source: 'iframe' };
  }

  return { doc: document, source: 'top' };
}

function detectExportPage() {
  return false;
}

function detectPageType() {
  return 'blackboard';
}

function extractAssignmentPageData(doc = document) {
  try {
    const main = findMainContentContainer(doc);
    if (!main) {
      console.error('[Blackboard Course Intel] No main content container detected for assignment extraction.');
      return null;
    }

    if (!looksLikeAssignmentPage(main)) {
      return null;
    }

    const assignmentTitle = extractAssignmentTitle(main);
    const dueAt = extractDueDate(main.innerText || doc.body?.innerText || '');
    const courseName = inferCourseName(doc, assignmentTitle);

    const rubricText = extractRubricText(main);
    const promptText = extractPromptText(main, rubricText);
    const requirements = extractRequirements(main);

    if (!assignmentTitle && !promptText && !rubricText) {
      console.error('[Blackboard Course Intel] Assignment-like page detected but no recognizable assignment fields were extracted.');
      return null;
    }

    return {
      courseName: normalizeText(courseName),
      assignmentTitle: normalizeText(assignmentTitle),
      dueAt,
      promptText: normalizeText(promptText),
      rubricText: normalizeText(rubricText),
      requirements: dedupeStrings(requirements.map(normalizeText).filter(Boolean))
    };
  } catch (error) {
    console.error('[Blackboard Course Intel] Assignment extraction failed:', error);
    return null;
  }
}

function findMainContentContainer(doc = document) {
  const candidates = [
    ...doc.querySelectorAll('main, [role="main"], article, section, div[id], div[class]')
  ];

  let best = null;
  let bestScore = -1;

  for (const node of candidates) {
    const text = normalizeText(node.innerText || '');
    if (text.length < 180) continue;

    const idCls = `${node.id || ''} ${node.className || ''}`.toLowerCase();
    let score = 0;

    if (/content|main|region-main|item|details|module|assignment/.test(idCls)) score += 5;
    if (/assignment|instructions|due|rubric/.test(text.toLowerCase())) score += 6;
    if (node.querySelector('h1, h2, h3')) score += 2;

    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }

  return best;
}

function looksLikeAssignmentPage(main) {
  const text = normalizeText(main.innerText || '').toLowerCase();
  const headingText = normalizeText(
    Array.from(main.querySelectorAll('h1, h2, h3, h4')).map((h) => h.textContent || '').join(' ')
  ).toLowerCase();

  const keywordCount = countMatches(text, ['assignment', 'instructions', 'due', 'rubric']);
  const headingCount = countMatches(headingText, ['assignment', 'instructions', 'due', 'rubric']);

  const hasRubricUi = Boolean(main.querySelector('[class*="rubric" i], [id*="rubric" i], table'));
  const hasInstructionUi = Boolean(main.querySelector('[class*="instruction" i], [id*="instruction" i], ol, ul'));

  return keywordCount >= 2 || headingCount >= 1 || hasRubricUi || hasInstructionUi;
}

function extractAssignmentTitle(main) {
  const headings = Array.from(main.querySelectorAll('h1, h2, h3, h4'));
  if (!headings.length) {
    return normalizeText(main?.ownerDocument?.title || '');
  }

  const topHeadings = headings.slice(0, 8);
  const preferOrder = ['H1', 'H2', 'H3', 'H4'];

  for (const tag of preferOrder) {
    const hit = topHeadings.find((h) => h.tagName === tag && normalizeText(h.textContent || '').length >= 3);
    if (hit) return normalizeText(hit.textContent || '');
  }

  return normalizeText(topHeadings[0].textContent || main?.ownerDocument?.title || '');
}

function inferCourseName(doc, assignmentTitle) {
  const crumbs = Array.from(
    doc.querySelectorAll(
      'nav a, [aria-label*="breadcrumb" i] a, .breadcrumb a, [class*="breadcrumb" i] a'
    )
  )
    .map((a) => normalizeText(a.textContent || ''))
    .filter(Boolean)
    .filter((t) => t.toLowerCase() !== (assignmentTitle || '').toLowerCase());

  if (crumbs.length) return crumbs[crumbs.length - 1];

  const topHeading = normalizeText((doc.querySelector('h1')?.textContent || '').trim());
  if (topHeading && topHeading.toLowerCase() !== (assignmentTitle || '').toLowerCase()) {
    return topHeading;
  }

  const pageTitle = normalizeText(doc.title || '');
  const parts = pageTitle.split(/[-|•:]/).map((p) => normalizeText(p)).filter(Boolean);
  if (parts.length > 1) return parts[0];

  return pageTitle;
}

function extractPromptText(main, rubricText) {
  const clone = main.cloneNode(true);
  for (const noisy of clone.querySelectorAll('nav, aside, header, footer, script, style, button')) {
    noisy.remove();
  }

  const sections = [];

  const instructionHeaders = Array.from(clone.querySelectorAll('h1, h2, h3, h4, strong')).filter((el) =>
    /instruction|prompt|description|details|task|overview/i.test(normalizeText(el.textContent || ''))
  );

  for (const header of instructionHeaders) {
    let chunk = normalizeText(header.textContent || '');
    let next = header.nextElementSibling;
    let steps = 0;
    while (next && steps < 6 && !/^H[1-4]$/.test(next.tagName)) {
      chunk += `\n${normalizeText(next.innerText || next.textContent || '')}`;
      next = next.nextElementSibling;
      steps += 1;
    }
    sections.push(chunk);
  }

  if (!sections.length) {
    const paragraphs = Array.from(clone.querySelectorAll('p, li'))
      .map((el) => normalizeText(el.innerText || el.textContent || ''))
      .filter((t) => t.length > 20)
      .slice(0, 30);
    sections.push(paragraphs.join('\n'));
  }

  let promptText = normalizeText(sections.join('\n'));
  if (rubricText) {
    const snippet = normalizeText(rubricText).slice(0, 200);
    if (snippet) promptText = promptText.replace(snippet, '').trim();
  }

  return stripNavigationText(promptText);
}

function extractRubricText(main) {
  const rubricNodes = Array.from(
    main.querySelectorAll(
      '[class*="rubric" i], [id*="rubric" i], section, article, div, table'
    )
  ).filter((node) => {
    const text = normalizeText(node.innerText || node.textContent || '');
    return /rubric|criteria|points|performance/i.test(text);
  });

  if (!rubricNodes.length) return '';

  const rubricParts = rubricNodes
    .map((node) => normalizeText(node.innerText || node.textContent || ''))
    .filter((t) => t.length > 10);

  return stripNavigationText(rubricParts.join('\n'));
}

function extractRequirements(main) {
  const reqs = [];

  for (const li of main.querySelectorAll('ul li, ol li')) {
    const text = normalizeText(li.innerText || li.textContent || '');
    if (text.length >= 4 && !isLikelyNavigationLine(text)) {
      reqs.push(text);
    }
  }

  for (const table of main.querySelectorAll('table')) {
    for (const row of table.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('th, td'))
        .map((cell) => normalizeText(cell.innerText || cell.textContent || ''))
        .filter(Boolean);
      if (cells.length) {
        const rowText = cells.join(' | ');
        if (!isLikelyNavigationLine(rowText)) reqs.push(rowText);
      }
    }
  }

  return dedupeStrings(reqs);
}

function extractAssignmentsFromPage(doc = document) {
  const pageSignals = getBlackboardPageSignals(doc);
  if (!pageSignals.allowed) return [];

  const results = [];
  const seen = new Set();
  const course = inferCourseName(doc, '');

  const candidateLinks = Array.from(doc.querySelectorAll('a'));
  for (const link of candidateLinks) {
    const label = normalizeText(link.textContent || '');
    const href = link.href || '';
    if (!label || !href) continue;

    const titleLower = label.toLowerCase();
    const looksLikeAssignment =
      titleLower.includes('assignment') ||
      titleLower.includes('quiz') ||
      titleLower.includes('exam') ||
      titleLower.includes('discussion') ||
      titleLower.includes('project') ||
      titleLower.includes('homework');

    if (!looksLikeAssignment) continue;

    const container = link.closest('li, tr, div, article, section') || link.parentElement;
    const surroundingText = container ? container.textContent || '' : '';
    const hasDueLabel = /\bdue\b/i.test(surroundingText);
    const hasPoints = /\b\d+(\.\d+)?\s*(points?|pts)\b|\bscore\b/i.test(surroundingText);
    const hasAssessmentCue = /\b(submit|attempt|assessment|assignment|discussion|quiz|test|exam|project|homework)\b/i
      .test(`${label} ${surroundingText}`);
    const looksLikeContentTile = pageSignals.isContentPage && hasDueLabel;
    const noPageContext = !pageSignals.isAssessmentPage && !pageSignals.isContentPage;

    const eligibleOnAssessmentPages = pageSignals.isAssessmentPage && (hasDueLabel || hasPoints || hasAssessmentCue);
    const eligibleOnContentPages = looksLikeContentTile && (hasAssessmentCue || hasPoints || titleLower.includes('discussion'));
    const eligibleOnUnknownPages = noPageContext && looksLikeAssignment;
    if (!eligibleOnAssessmentPages && !eligibleOnContentPages && !eligibleOnUnknownPages) continue;

    const dueAt = extractDueDate(surroundingText);
    const id = makeId(href, label, dueAt);

    if (seen.has(id)) continue;
    seen.add(id);

    results.push({
      id,
      title: label,
      dueAt,
      url: href,
      course,
      scannedAt: new Date().toISOString(),
      typeGuess: guessAssignmentType(`${label} ${surroundingText}`)
    });
  }

  return results;
}

function extractAssignmentsFromExportSummary(doc = document, options = {}) {
  const debugTitles = Boolean(options.debugTitles);
  const assignments = [];
  const seen = new Set();
  const tables = Array.from(doc.querySelectorAll('table'));

  for (const table of tables) {
    const headers = Array.from(table.querySelectorAll('thead th, tr th')).map((th) => normalizeHeader(th.textContent || ''));
    if (!headers.length) continue;

    const dueIdx = findHeaderIndex(headers, ['due']);
    const courseIdx = findHeaderIndex(headers, ['course']);
    const titleIdx = findHeaderIndex(headers, ['assignment title', 'assignment']);
    const reqIdx = findHeaderIndex(headers, ['requirements']);
    const urgencyIdx = findHeaderIndex(headers, ['urgency']);
    if (dueIdx < 0 || courseIdx < 0 || titleIdx < 0) continue;

    const rows = table.querySelectorAll('tbody tr, tr');
    let debugRowCount = 0;
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, th'));
      if (!cells.length) continue;
      const titleFromTitleCol = normalizeText(cells[titleIdx]?.innerText || cells[titleIdx]?.textContent || '');
      const titleFromRequirementsCol = normalizeText(cells[reqIdx]?.innerText || cells[reqIdx]?.textContent || '');
      const titleColGeneric = isGenericExportTitle(titleFromTitleCol);
      const fallbackTitle = deriveTitleFromRequirements(titleFromRequirementsCol);
      const chosenTitle = titleColGeneric ? fallbackTitle : titleFromTitleCol;
      const sourceTitle = titleColGeneric ? 'requirementsFallback' : 'titleCol';

      if (debugTitles && debugRowCount < 10) {
        const indexedCells = cells.map((cell, idx) => `${idx}:"${normalizeText(cell.innerText || cell.textContent || '')}"`);
        console.log(`Row ${debugRowCount + 1} cells:`, indexedCells);
        console.log('titleFromTitleCol (col 4):', titleFromTitleCol);
        console.log('titleFromRequirementsCol (col 5):', titleFromRequirementsCol);
        console.log('chosenTitle:', chosenTitle);
        debugRowCount += 1;
      }

      if (!chosenTitle || chosenTitle === '-') continue;

      const dueText = normalizeText(cells[dueIdx]?.innerText || cells[dueIdx]?.textContent || '');
      const dueAt = parsePossibleDate(dueText) || extractDueDate(`Due: ${dueText}`);
      const course = normalizeText(cells[courseIdx]?.innerText || cells[courseIdx]?.textContent || '');
      const requirementsText = normalizeText(cells[reqIdx]?.innerText || cells[reqIdx]?.textContent || '');
      const urgency = normalizeText(cells[urgencyIdx]?.innerText || cells[urgencyIdx]?.textContent || '');
      const urgencyScore = parseUrgencyScore(urgency);
      const rowUrl = cells[titleIdx]?.querySelector('a[href]')?.href || getCurrentHref();

      const key = `${rowUrl}|${chosenTitle}|${dueAt || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      assignments.push({
        id: makeId(rowUrl, chosenTitle, dueAt),
        title: chosenTitle,
        dueAt,
        url: rowUrl,
        course,
        scannedAt: new Date().toISOString(),
        typeGuess: guessAssignmentType(`${chosenTitle} ${requirementsText}`),
        urgencyScore,
        details: {
          extractor: 'export-summary-table',
          sourceTitle,
          requirements: requirementsText && requirementsText !== '-' ? [requirementsText] : [],
          urgency
        }
      });
    }
  }

  return assignments;
}

function extractCourseContentPage(doc = document) {
  const headingText = normalizeText(
    Array.from(doc.querySelectorAll('h1, h2, h3')).map((h) => h.textContent || '').join(' ')
  ).toLowerCase();
  const looksLikeCourseContentPage =
    /course content|content|module|learning module|week/i.test(headingText) ||
    /\/ultra\/courses\/.*\/outline/i.test(location.href);

  if (!looksLikeCourseContentPage) return [];

  const items = [];
  const seen = new Set();
  const course = inferCourseName(doc, '');
  const blocks = Array.from(doc.querySelectorAll('li, article, section, tr, div')).slice(0, 2000);

  for (const block of blocks) {
    const text = normalizeText(block.innerText || block.textContent || '');
    if (text.length < 20 || text.length > 5000) continue;

    const primary = findPrimaryLink(block);
    if (!primary?.href) continue;
    if (isLikelyNavigationLine(normalizeText(primary.textContent || ''))) continue;

    const hasDueLabel = /\bdue\b/i.test(text);
    const hasPoints = /\b\d+(\.\d+)?\s*(points?|pts)\b|\bscore\b/i.test(text);
    const hasAssessmentMarker = /\bassignment|discussion|quiz|test|exam|project|assessment|submit|attempt\b/i.test(text);
    if (!(hasDueLabel || hasPoints || hasAssessmentMarker)) continue;

    const title = getBestVisibleTitle(block, primary);
    if (!title) continue;

    const dueAt = extractDueDate(text);
    const typeGuess = guessAssignmentType(`${title} ${text}`);
    const key = `${primary.href}|${title}|${dueAt || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      id: makeId(primary.href, title, dueAt),
      title,
      dueAt,
      url: primary.href,
      course,
      scannedAt: new Date().toISOString(),
      typeGuess,
      details: {
        extractor: 'course-content-ultra',
        indicators: {
          hasDueLabel,
          hasPoints,
          hasAssessmentMarker
        }
      }
    });
  }

  return items;
}

function extractQuizzesTestsListPage(doc = document) {
  const out = [];
  const seen = new Set();
  const course = inferCourseName(doc, '');
  const containers = [];

  for (const node of doc.querySelectorAll('section, article, div, main')) {
    const title = normalizeText(
      [
        node.querySelector('h1, h2, h3, h4')?.textContent || '',
        node.getAttribute('aria-label') || '',
        node.getAttribute('data-testid') || ''
      ].join(' ')
    );
    if (/\btests?\b|\bquizzes?\b|\bassessments?\b/i.test(title)) {
      containers.push(node);
    }
  }

  if (!containers.length && /\/(assessments|tests?|quizzes)/i.test(location.href)) {
    containers.push(doc.body);
  }

  for (const container of containers) {
    const links = Array.from(container.querySelectorAll('a[href]'));
    for (const link of links) {
      const linkText = normalizeText(link.textContent || link.getAttribute('aria-label') || '');
      const href = link.href || '';
      if (!href) continue;
      const row = link.closest('li, tr, article, section, div') || link;
      const rowText = normalizeText(row.innerText || row.textContent || '');

      const isAssessment =
        /\bquiz|test|exam|assessment\b/i.test(`${linkText} ${rowText}`) ||
        /\b(attempt|details?|start|launch|view)\b/i.test(linkText);
      if (!isAssessment) continue;

      const title = getBestVisibleTitle(row, link);
      if (!title) continue;

      const dueAt = extractDueDate(rowText);
      const key = `${href}|${title}|${dueAt || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        id: makeId(href, title, dueAt),
        title,
        dueAt,
        url: href,
        course,
        scannedAt: new Date().toISOString(),
        typeGuess: guessAssignmentType(`${title} ${rowText}`),
        details: {
          extractor: 'tests-assessments-list',
          linkText
        }
      });
    }
  }

  return out;
}

function mergeAssignmentResults(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of group || []) {
      const key = `${item.url || ''}|${normalizeText(item.title || '')}|${item.dueAt || ''}`;
      if (!item.title || !item.url || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function findPrimaryLink(block) {
  const links = Array.from(block.querySelectorAll('a[href]'));
  if (!links.length) return null;

  const keyword = links.find((a) => /(assignment|content|launch|attempt|detail|view|quiz|test|assessment)/i.test(a.href || ''));
  if (keyword) return keyword;

  let best = null;
  let bestLen = -1;
  for (const a of links) {
    const text = normalizeText(a.textContent || a.getAttribute('aria-label') || '');
    if (text.length > bestLen) {
      best = a;
      bestLen = text.length;
    }
  }
  return best;
}

function getBestVisibleTitle(row, fallbackLink) {
  const primary = findPrimaryLink(row) || fallbackLink || null;
  const linkText = normalizeText(primary?.textContent || primary?.getAttribute('aria-label') || '');
  if (linkText && !isLikelyGenericTitle(linkText)) return linkText;

  const heading = Array.from(row.querySelectorAll('h1, h2, h3'))
    .map((h) => normalizeText(h.textContent || ''))
    .find((t) => t && !isLikelyGenericTitle(t));
  if (heading) return heading;

  const named = Array.from(row.querySelectorAll('[data-testid], [aria-label]'))
    .map((el) => normalizeText(el.getAttribute('aria-label') || el.textContent || ''))
    .find((t) => /(title|name)/i.test(t) && !isLikelyGenericTitle(t));
  if (named) return named;

  const firstLine = normalizeText((row.innerText || '').split('\n').find((line) => normalizeText(line)));
  if (!firstLine) return '';
  return normalizeText(
    firstLine.replace(/\b(Assignment|Test|Discussion|Content|Due|Points|Status)\b/gi, ' ')
  );
}

function isLikelyGenericTitle(text) {
  return /^(assignment|test|discussion|content|due|points|status|view|open)$/i.test(normalizeText(text));
}

function guessAssignmentType(text) {
  const t = normalizeText(text).toLowerCase();
  if (/discussion/.test(t)) return 'discussion';
  if (/quiz|test/.test(t)) return 'quiz/test';
  if (/project/.test(t)) return 'project';
  if (/exam/.test(t)) return 'exam';
  if (/assignment/.test(t)) return 'assignment';
  return 'assignment';
}

function extractCourseLinks(doc = document) {
  const links = new Set();
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const href = anchor.href;
    const text = normalizeText(anchor.textContent || '').toLowerCase();
    const lowerHref = href.toLowerCase();

    const looksLikeCourse =
      text.includes('course') ||
      text.includes('my courses') ||
      lowerHref.includes('/ultra/courses/') ||
      lowerHref.includes('course_id=') ||
      lowerHref.includes('/webapps/blackboard/content/listcontent.jsp');

    if (looksLikeCourse) {
      links.add(href);
    }
  }

  return Array.from(links);
}

function getBlackboardPageSignals(doc = document) {
  const url = getCurrentHref().toLowerCase();
  const headingText = normalizeText(
    Array.from(doc.querySelectorAll('h1, h2, h3, [aria-label], [data-testid]'))
      .slice(0, 40)
      .map((el) => `${el.textContent || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('data-testid') || ''}`)
      .join(' ')
  ).toLowerCase();
  const pageTitle = normalizeText(doc.title || '').toLowerCase();
  const composite = `${url} ${headingText} ${pageTitle}`;
  const isAssessmentPage = /\bassignments?\b|\bassessments?\b|\btests?\b|\bquizzes?\b/.test(composite);
  const isContentPage = /\bcourse content\b|\/outline\b|\bcontent\b/.test(composite);
  const hasDueTilesFromBlocks = Boolean(
    Array.from(doc.querySelectorAll('li, article, section, tr, div'))
      .slice(0, 400)
      .find((node) => /\bdue\b/i.test(normalizeText(node.textContent || '')))
  );
  const hasDueTilesFromAnchors = Boolean(
    Array.from(doc.querySelectorAll('a'))
      .slice(0, 400)
      .find((a) => {
        const host = a.closest?.('li, article, section, tr, div') || a.parentElement || a;
        return /\bdue\b/i.test(normalizeText(host?.textContent || ''));
      })
  );
  const hasDueTiles = hasDueTilesFromBlocks || hasDueTilesFromAnchors;
  const hasContext = Boolean(url || headingText || pageTitle);
  const isLikelyTestHarness = !hasContext;

  return {
    allowed: isLikelyTestHarness || isAssessmentPage || (isContentPage && hasDueTiles) || hasDueTiles,
    isAssessmentPage,
    isContentPage,
    hasDueTiles
  };
}

function findHeaderIndex(headers, acceptableNames) {
  for (let i = 0; i < headers.length; i += 1) {
    for (const acceptable of acceptableNames) {
      if (headers[i] === acceptable || headers[i].includes(acceptable)) return i;
    }
  }
  return -1;
}

function normalizeHeader(input) {
  return normalizeText(input).toLowerCase().replace(/\s+/g, ' ');
}

function isGenericExportTitle(titleCol) {
  const t = normalizeText(titleCol);
  if (!t || t === '-') return true;
  if (t.length < 4) return true;
  return /^(discussions?|assignments?|quizzes?|tests?)$/i.test(t);
}

function deriveTitleFromRequirements(reqCol) {
  const req = normalizeText(reqCol);
  if (!req || req === '-') return '';

  const firstSegment = normalizeText(req.split(';')[0] || '');
  if (!firstSegment) return '';

  let title = firstSegment;
  const splitParts = firstSegment.split(/\s{2,}|•/).map((p) => normalizeText(p)).filter(Boolean);
  if (splitParts.length) {
    title = splitParts[0];
  }

  if (title.length > 80) {
    const clipped = title.slice(0, 80);
    const cleanCut = clipped.replace(/\s+\S*$/, '').trim();
    title = `${cleanCut || clipped}…`;
  }

  return normalizeText(title);
}

function parseUrgencyScore(value) {
  const n = Number.parseInt(normalizeText(value), 10);
  if (Number.isNaN(n)) return undefined;
  return Math.max(0, Math.min(100, n));
}

function extractDueDate(text) {
  const compact = normalizeText(text);
  const patterns = [
    /(?:due|deadline)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /(?:due|deadline)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /(?:due|deadline)\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i
  ];

  for (const re of patterns) {
    const match = compact.match(re);
    if (!match) continue;
    const parsed = parsePossibleDate(match[1]);
    if (parsed) return parsed;
  }

  return null;
}

function normalizeText(input) {
  return String(input || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNavigationText(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .filter((line) => !isLikelyNavigationLine(line));

  return normalizeText(lines.join('\n'));
}

function isLikelyNavigationLine(line) {
  const t = normalizeText(line).toLowerCase();
  if (!t) return true;
  const navPatterns = [
    /^skip to main content$/,
    /^content$/,
    /^calendar$/,
    /^gradebook$/,
    /^messages?$/,
    /^groups?$/,
    /^announcements?$/,
    /^help for current page$/,
    /^course status open$/,
    /^open$/
  ];

  return navPatterns.some((re) => re.test(t));
}

function dedupeStrings(items) {
  return Array.from(new Set(items.map((s) => normalizeText(s)).filter(Boolean)));
}

function countMatches(text, words) {
  const t = String(text || '').toLowerCase();
  let count = 0;
  for (const w of words) {
    if (t.includes(w.toLowerCase())) count += 1;
  }
  return count;
}

function makeId(url, title, dueAt) {
  return `${url}|${title}|${dueAt || ''}`;
}

function getCurrentHref() {
  return globalThis.location?.href || '';
}

function getCurrentPathname() {
  return globalThis.location?.pathname || '';
}

function parsePossibleDate(input) {
  const raw = normalizeText(input).replace(/\bat\b/i, ' ');
  const direct = Date.parse(raw);
  if (!Number.isNaN(direct)) {
    return new Date(direct).toISOString();
  }

  if (/^[A-Za-z]{3,9}\s+\d{1,2}(\s+\d{1,2}:\d{2}\s*(AM|PM)?)?$/i.test(raw)) {
    const withYear = `${raw} ${new Date().getFullYear()}`;
    const parsed = Date.parse(withYear);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return null;
}
