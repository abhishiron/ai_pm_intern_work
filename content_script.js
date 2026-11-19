'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'scrapeProfile') {
    scrapeWithScroll().then(profile => {
      sendResponse({ success: true, data: profile });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

async function scrapeWithScroll() {
  window.scrollTo(0, 800);  await wait(500);
  window.scrollTo(0, 1600); await wait(500);
  window.scrollTo(0, 2400); await wait(600);
  window.scrollTo(0, 0);    await wait(300);
  return scrapeProfile();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scrapeProfile() {
  const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();

  // Find section by h2 heading text
  function getSection(heading) {
    return Array.from(document.querySelectorAll('section')).find(s =>
      s.querySelector('h2')?.innerText?.trim().toLowerCase().includes(heading.toLowerCase())
    ) || null;
  }

  // Get all leaf text nodes from a section using P tags and spans
  function getTexts(section) {
    if (!section) return [];
    return Array.from(section.querySelectorAll('p, span'))
      .filter(el => el.children.length === 0)
      .map(el => clean(el.innerText))
      .filter(t => t.length > 2 && !/^[·•\s]+$/.test(t));
  }

  // ── NAME ──────────────────────────────────────────────────────────────────
  const name = clean(document.querySelector('h1')?.innerText) ||
               clean(document.title.split('|')[0]);

  // ── HEADLINE ──────────────────────────────────────────────────────────────
  let headline = null;
  const allSections = Array.from(document.querySelectorAll('section'));
  for (const sec of allSections) {
    if (sec.querySelector('h1')) {
      const pTags = Array.from(sec.querySelectorAll('p'))
        .filter(p => p.children.length === 0)
        .map(p => clean(p.innerText))
        .filter(t => t.length > 5 && t !== name);
      // Headline often contains | or @ or job title keywords
      const headlineEl = pTags.find(t =>
        t.includes('|') || t.includes('@') || t.includes('·') ||
        /manager|engineer|analyst|developer|designer|founder|director|lead|specialist|consultant|intern|fellow|trainee/i.test(t)
      ) || pTags[0];
      if (headlineEl) { headline = headlineEl; break; }
    }
  }

  // ── LOCATION ──────────────────────────────────────────────────────────────
  let location = null;
  for (const sec of allSections) {
    if (sec.querySelector('h1')) {
      const pTags = Array.from(sec.querySelectorAll('p'))
        .filter(p => p.children.length === 0)
        .map(p => clean(p.innerText))
        .filter(t => t.length > 3);
      // Location is usually the 2nd or 3rd p tag — looks like "City, Country"
      const locEl = pTags.find(t =>
        t !== headline && t.includes(',') && t.length < 60 && !t.includes('|') && !t.includes('@')
      );
      if (locEl) { location = locEl; break; }
    }
  }

  // ── ABOUT ─────────────────────────────────────────────────────────────────
  let about = null;
  const aboutSection = getSection('About');
  if (aboutSection) {
    const texts = getTexts(aboutSection);
    const longText = texts.find(t => t.length > 80 && !t.includes('Experience') && !t.includes('Skills'));
    if (longText) about = longText;
  }

  // ── EXPERIENCE ────────────────────────────────────────────────────────────
  // Each entry is: title, company, then any number of date / location lines.
  // We walk line by line instead of assuming a fixed 3-or-4 line stride.
  const experienceEntries = [];
  const expSection = getSection('Experience');
  if (expSection) {
    const pTags = Array.from(expSection.querySelectorAll('p'))
      .filter(p => p.children.length === 0)
      .map(p => clean(p.innerText))
      .filter(t => t.length > 2 && t !== 'Experience');

    let i = 0;
    while (i < pTags.length) {
      const title = pTags[i];

      // Skip stray date / work-mode lines and long description paragraphs
      if (isDateLine(title) || isWorkModeLine(title) || title.length > 100) { i++; continue; }

      const company = pTags[i + 1] || null;
      let j = i + 2;
      let duration = null;
      // Dates come first, then an optional location line. A comma line is only
      // treated as a location if it is NOT the start of the next entry
      // (title, company, date) — so "Founder, CEO" stays a job title.
      while (j < pTags.length) {
        const line = pTags[j];
        if (isDateLine(line)) { if (!duration) duration = line; j++; continue; }
        if (duration && isDateLine(pTags[j - 1] || '')) {
          if (isWorkModeLine(line)) { j++; continue; }
          const startsNextEntry = isDateLine(pTags[j + 2] || '');
          if (isLocationLine(line) && !startsNextEntry) { j++; continue; }
        }
        break;
      }

      experienceEntries.push({
        title,
        company:   company ? company.split('·')[0].trim() : null,
        duration,
        isCurrent: duration ? /present/i.test(duration) : experienceEntries.length === 0
      });

      i = Math.max(j, i + 2);
    }
  }

  const currentEntry   = experienceEntries[0] || null;
  const currentTitle   = currentEntry?.title   || extractFromHeadline(headline, 'title');
  const currentCompany = currentEntry?.company || extractFromHeadline(headline, 'company');
  const pastCompanies  = [...new Set(
    experienceEntries.slice(1).map(e => e.company).filter(Boolean)
  )];

  // ── SKILLS ────────────────────────────────────────────────────────────────
  const skills = [];
  const skillsSection = getSection('Skills');
  if (skillsSection) {
    const texts = getTexts(skillsSection);
    texts.filter(t =>
      t !== 'Skills' &&
      t.length < 60 &&
      t.length > 2 &&
      !/\d{4}|follower|connection|endorsement|endorse|show all|see all|dialog|window|escape/i.test(t)
    ).forEach(t => skills.push(t));
  }

  // ── EDUCATION ─────────────────────────────────────────────────────────────
  const educationEntries = [];
  const eduSection = getSection('Education');
  if (eduSection) {
    const pTags = Array.from(eduSection.querySelectorAll('p'))
      .filter(p => p.children.length === 0)
      .map(p => clean(p.innerText))
      .filter(t => t.length > 2 && t !== 'Education');
    for (let i = 0; i < pTags.length; i += 3) {
      if (pTags[i]) educationEntries.push(
        [pTags[i], pTags[i+1]].filter(Boolean).join(' — ')
      );
    }
  }

  // ── RECENT POSTS ──────────────────────────────────────────────────────────
  const recentPosts = [];
  const activitySection = getSection('Activity');
  if (activitySection) {
    Array.from(activitySection.querySelectorAll('p, span'))
      .filter(el => el.children.length === 0)
      .map(el => clean(el.innerText))
      .filter(t =>
        t.length > 40 && t.length < 500 &&
        !/dialog|window|escape|cancel|close|beginning|notifications|premium|people you may|you might/i.test(t)
      )
      .forEach(t => { if (!recentPosts.includes(t)) recentPosts.push(t); });
  }

  return {
    name,
    headline,
    currentTitle,
    currentCompany,
    location,
    about,
    recentPosts:       recentPosts.slice(0, 3),
    experienceEntries: experienceEntries.slice(0, 5),
    pastCompanies:     pastCompanies.slice(0, 4),
    educationEntries:  educationEntries.slice(0, 3),
    skills:            skills.slice(0, 10),
    profileUrl:        window.location.href.split('?')[0],
    rawTitle:          document.title
  };
}

// A date line starts with a year, or a month followed by a year,
// e.g. "2021 - Present", "Jan 2022 - Mar 2024 · 2 yrs 3 mos".
// Anchored at the start so job titles like "Marketing Manager" or
// "Sales Representative" are no longer mistaken for dates.
function isDateLine(t) {
  return /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?\d{4}\b/i.test(t) ||
         /^present\b/i.test(t) ||
         /^\d+\s*(?:yrs?|mos?)\b/i.test(t);
}

// "Remote", "Hybrid", "On-site", or "Pune, India · Hybrid"
function isWorkModeLine(t) {
  return /^(?:remote|on-?site|hybrid)$/i.test(t) || /·\s*(?:remote|on-?site|hybrid)$/i.test(t);
}

// A short "City, Country" / "City Area" style line with no digits.
// Replaces the old hard-coded list of Indian cities.
function isLocationLine(t) {
  if (/\b(?:area|metropolitan)\b/i.test(t) && !/\d/.test(t) && t.length < 60) return true;
  return t.includes(',') && t.length < 60 && !/\d/.test(t) && t.split(' ').length <= 6;
}

function extractFromHeadline(headline, field) {
  if (!headline) return null;
  const atMatch = headline.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return field === 'title' ? atMatch[1].trim() : atMatch[2].trim();
  const pipeMatch = headline.match(/^(.+?)\s*[|·]\s*(.+)$/);
  if (pipeMatch) return field === 'title' ? pipeMatch[1].trim() : pipeMatch[2].trim();
  return null;
}