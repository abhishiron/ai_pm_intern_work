'use strict';

// background.js — message routing, hook finding and message writing.
// Free Mode: rule-based hooks + templates, nothing leaves the browser.
// AI Mode: the user's OWN Anthropic API key (Settings) for hooks, messages and résumé reading.

const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-5-5';

// ─── Router ───────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === 'scrapeProfile') {
    handleScrapeProfile(sendResponse);
    return true;
  }

  if (message.action === 'generateMessage') {
    handleQuickGenerate(message.data, sendResponse);
    return true;
  }

  if (message.type === 'TEST_API_KEY') {
    handleTestKey(message.payload, sendResponse);
    return true;
  }

  if (message.type === 'RUN_ENRICH') {
    handleEnrich(message.payload, sendResponse);
    return true;
  }

  if (message.type === 'RUN_GENERATE') {
    handleDeepGenerate(message.payload, sendResponse);
    return true;
  }

  if (message.type === 'PARSE_RESUME') {
    handleParseResume(sendResponse);
    return true;
  }
});
// (Removed SAVE_RECENT / GET_RECENT: never called — the popup uses utils/cache.js.)

// ─── Scrape profile from active tab ───────────────────────────────────────────
async function handleScrapeProfile(sendResponse) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab  = tabs[0];
    if (!tab) throw new Error('No active tab found.');
    if (!tab.url || !tab.url.includes('linkedin.com')) {
      throw new Error('Please navigate to a LinkedIn profile page first.');
    }

    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
      await delay(400);
      result = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
    }

    if (!result?.success) throw new Error(result?.error || 'Scrape failed.');
    sendResponse({ success: true, data: result.data });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Test user's own API key ──────────────────────────────────────────────────
async function handleTestKey({ apiKey }, sendResponse) {
  try {
    await callClaude(apiKey, 'Reply with the single word: OK', 10);
    sendResponse({ valid: true });
  } catch (err) {
    sendResponse({ valid: false, reason: err.message });
  }
}

// ─── Résumé: read it once with Claude, keep only a small structured summary ───
// The uploaded PDF used to be stored and never read. Now Claude extracts the
// facts that matter for outreach, and those are matched against each profile.
async function handleParseResume(sendResponse) {
  try {
    const apiKey = await getApiKey();
    const { resumeBase64 } = await storageGet(['resumeBase64']);
    if (!resumeBase64) throw new Error('No résumé saved yet.');
    if (!apiKey) throw new Error('Add your Anthropic API key so Claude can read your résumé.');

    const raw = await callClaude(apiKey, [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resumeBase64 } },
      { type: 'text', text:
`Extract facts from this résumé for personalising LinkedIn outreach.
Reply with ONLY JSON in this shape, no other text:
{"name":"","headline":"one line, max 100 chars","schools":[],"companies":[],"skills":[],"locations":[],"summary":"2 sentences in first person, max 300 chars"}
Use short canonical names (e.g. "IIT Delhi", "Google"). Max 15 skills.` }
    ], 700);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Could not read the résumé.');
    const parsed = JSON.parse(match[0]);
    const resumeProfile = {
      name:      String(parsed.name || ''),
      headline:  String(parsed.headline || ''),
      schools:   toList(parsed.schools),
      companies: toList(parsed.companies),
      skills:    toList(parsed.skills).slice(0, 15),
      locations: toList(parsed.locations),
      summary:   String(parsed.summary || '')
    };
    await new Promise(r => chrome.storage.local.set({ resumeProfile }, r));
    sendResponse({ success: true, data: resumeProfile });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Common ground between the user (résumé) and the profile ──────────────────
function findCommonGround(me, p) {
  if (!me) return [];
  const out = [];

  const theirSchools = p.educationEntries.map(stringify);
  const school = me.schools.find(s => theirSchools.some(t => sameOrg(s, t)));
  if (school) out.push(`You both studied at ${school}`);

  const theirCompanies = [p.currentCompany, ...p.pastCompanies, ...p.experienceEntries.map(e => e.company)].filter(Boolean);
  const company = me.companies.find(c => theirCompanies.some(t => sameOrg(c, t)));
  if (company) out.push(`You both worked at ${company}`);

  const theirSkills = p.skills.map(s => s.toLowerCase());
  const skills = me.skills.filter(s => theirSkills.includes(s.toLowerCase())).slice(0, 2);
  if (skills.length) out.push(`You both work with ${skills.join(' and ')}`);

  const city = me.locations.find(l => p.location && p.location.toLowerCase().includes(l.split(',')[0].trim().toLowerCase()));
  if (city && !out.length) out.push(`You're both based in ${city.split(',')[0].trim()}`);

  return out;
}

// "IIM Bangalore" vs "Indian Institute of Management Bangalore — MBA": match on
// the full name, or on all significant words of the shorter name.
function sameOrg(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y || y.includes(x) || x.includes(y)) return true;
  const stop = new Set(['of', 'the', 'and', 'at', 'in', 'for', 'university', 'college', 'institute', 'inc', 'ltd', 'pvt', 'limited', 'technology', 'technologies']);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const longWords = long.split(' ');
  // Initials of the longer name, e.g. "indian institute of management bangalore" → "iimb"
  const initials  = longWords.filter(w => !['of', 'the', 'and', 'for'].includes(w)).map(w => w[0]).join('');
  const words = short.split(' ').filter(w => w.length > 1 && !stop.has(w));
  return words.length > 0 && words.every(w => longWords.includes(w) || (w.length >= 2 && w.length <= 5 && initials.includes(w)));
}

async function hooksFor(p) {
  const { resumeProfile } = await storageGet(['resumeProfile']);
  const common = findCommonGround(resumeProfile, p);
  // Common ground first — it's the strongest reason for a stranger to reply —
  // but capped at 2 so there's always room for something about *them*.
  return [...common.slice(0, 2), ...buildHooks(p)].slice(0, 4);
}

// ─── Quick Mode generate ──────────────────────────────────────────────────────
async function handleQuickGenerate(data, sendResponse) {
  try {
    const { profileData, messageType, tone, format } = data;
    const settings = { ...(data.settings || {}), ...(await storageGet(['resumeProfile'])), format };
    const p     = normalizeProfile(profileData);
    const hooks = await hooksFor(p);
    const apiKey = await getApiKey();

    const message = apiKey
      ? await aiMessage(apiKey, p, hooks, messageType, tone, settings)
      : localMessage(p, hooks, messageType, tone, settings);

    sendResponse({ success: true, generatedMessage: message });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Deep Mode step 2: find hooks ─────────────────────────────────────────────
// With a key, Claude picks the strongest talking points. Without one, the same
// rule-based hooks as Quick Mode are used — and the UI says so honestly.
async function handleEnrich({ rawProfileData, messageType }, sendResponse) {
  try {
    const profileJSON = normalizeProfile(rawProfileData);
    const apiKey      = await getApiKey();
    const { resumeProfile } = await storageGet(['resumeProfile']);
    const common      = findCommonGround(resumeProfile, profileJSON);
    let topHooks      = await hooksFor(profileJSON);
    let source        = 'rules';

    if (apiKey) {
      try {
        const aiHooks = await findHooksWithClaude(apiKey, profileJSON, messageType, resumeProfile);
        // Rule-matched common ground is exact, so it always stays on top
        if (aiHooks.length) { topHooks = [...common.slice(0, 2), ...aiHooks.filter(h => !common.includes(h))].slice(0, 4); source = 'claude'; }
      } catch (_) { /* fall back to rule-based hooks */ }
    }

    sendResponse({ status: 'enrich_complete', profileJSON, enrichmentJSON: { topHooks, source } });
  } catch (err) {
    sendResponse({ status: 'error', error: err.message });
  }
}

async function findHooksWithClaude(apiKey, p, messageType, me) {
  const prompt =
`You help someone write a LinkedIn outreach message (purpose: ${messageType || 'Networking'}).
From this profile, pick the 3 most specific, personal talking points they could open with.
Prefer concrete things (a recent post, a project, a career move) over generic ones (job title, "skilled in X").
${me ? `The sender's background (prefer hooks that connect to it): ${JSON.stringify(me)}` : ''}
Profile: ${JSON.stringify({
    name: p.name, headline: p.headline, title: p.currentTitle, company: p.currentCompany, location: p.location,
    about: truncate(p.about, 600), recentPosts: p.recentPosts, experience: p.experienceEntries,
    education: p.educationEntries, skills: p.skills
  })}
Reply with ONLY a JSON array of 3 short strings (max 90 characters each), no other text.`;
  const raw   = await callClaude(apiKey, prompt, 300);
  const match = raw.match(/\[[\s\S]*\]/);
  const list  = match ? JSON.parse(match[0]) : [];
  return list.filter(h => typeof h === 'string' && h.trim()).map(h => truncate(h, 120)).slice(0, 3);
}

// ─── Deep Mode step 3: write message from the hooks the user kept ─────────────
async function handleDeepGenerate({ profileJSON, enrichmentJSON, selectedHooks, messageType, tone, format }, sendResponse) {
  try {
    const settings = { ...(await storageGet(['userName', 'userBio', 'resumeProfile'])), format };
    const hooks    = Array.isArray(selectedHooks) ? selectedHooks : (enrichmentJSON?.topHooks || []);
    const apiKey   = await getApiKey();

    const message = apiKey
      ? await aiMessage(apiKey, profileJSON, hooks, messageType, tone, settings)
      : localMessage(profileJSON, hooks, messageType, tone, settings);

    sendResponse({ status: 'generate_complete', generatedMessage: message });
  } catch (err) {
    sendResponse({ status: 'error', error: err.message });
  }
}

// ─── Profile helpers ──────────────────────────────────────────────────────────
function normalizeProfile(raw = {}) {
  return {
    name:              (raw.name || '').trim(),
    firstName:         ((raw.name || '').trim().split(/\s+/)[0]) || 'there',
    headline:          raw.headline || '',
    currentTitle:      raw.currentTitle || '',
    currentCompany:    raw.currentCompany || '',
    location:          raw.location || '',
    about:             raw.about || '',
    recentPosts:       raw.recentPosts || [],
    experienceEntries: raw.experienceEntries || [],
    pastCompanies:     raw.pastCompanies || [],
    educationEntries:  raw.educationEntries || [],
    skills:            raw.skills || [],
    profileUrl:        raw.profileUrl || ''
  };
}

function buildHooks(p) {
  const hooks = [];
  if (p.recentPosts.length) hooks.push(`Recent post: "${truncate(p.recentPosts[0], 90)}"`);
  if (p.currentTitle && p.currentCompany) hooks.push(`Works as ${p.currentTitle} at ${p.currentCompany}`);
  else if (p.currentCompany) hooks.push(`Currently at ${p.currentCompany}`);
  if (p.skills.length) hooks.push(`Skilled in ${p.skills.slice(0, 3).join(', ')}`);
  if (p.pastCompanies.length) hooks.push(`Previously at ${p.pastCompanies.slice(0, 2).join(' and ')}`);
  if (p.educationEntries.length) hooks.push(`Studied at ${stringify(p.educationEntries[0])}`);
  if (!hooks.length && p.headline) hooks.push(`Headline: ${p.headline}`);
  return hooks.slice(0, 3);
}

// ─── Local (free) message writer ──────────────────────────────────────────────
function localMessage(p, hooks, messageType, tone, settings = {}) {
  const me   = (settings.userName || '').trim();
  const bio  = (settings.userBio || '').trim();
  const role = p.currentTitle || p.headline || 'your work';
  const co   = p.currentCompany ? ` at ${p.currentCompany}` : '';

  const greet = { Formal: `Dear ${p.firstName},`, Neutral: `Hi ${p.firstName},`, Casual: `Hey ${p.firstName}!` }[tone] || `Hi ${p.firstName},`;
  const close = { Formal: 'Kind regards,', Neutral: 'Best,', Casual: 'Cheers,' }[tone] || 'Best,';

  let hookLine = `I came across your profile and was impressed by your work as ${role}${co}.`;
  if (hooks.length) {
    hookLine = hookToSentence(hooks[0]);
    // Shared background is a bridge, not the whole message — follow it with a real hook
    const isCommon = h => /^You(?:'re)? both /.test(h);
    const theirs   = hooks.find(h => !isCommon(h));
    if (isCommon(hooks[0]) && theirs) hookLine += ' ' + hookToSentence(theirs);
  }
  else if (p.recentPosts.length) hookLine = `I enjoyed your recent post about "${truncate(p.recentPosts[0], 60)}".`;
  else if (p.skills.length) hookLine = `Your experience in ${p.skills.slice(0, 2).join(' and ')}${co} caught my attention.`;

  const aboutMe = bio || settings.resumeProfile?.summary || '';
  const intro = aboutMe ? ` A bit about me: ${truncate(aboutMe, 120)}` : '';

  const ask = {
    Networking:    `I'd love to connect and exchange ideas.`,
    Job:           `I'm exploring opportunities${co ? ' with your team' : ''} and would really value a quick chat about any relevant openings.`,
    Referral:      `If you're open to it, I'd be grateful for any guidance on roles${co} — or a referral if you think I'd be a fit.`,
    Collaboration: `I think there could be a great opportunity for us to collaborate and would love to explore it.`
  }[messageType] || `I'd love to connect.`;

  if (settings.format === 'note') return fitNote(greet, hookLine, intro, NOTE_ASKS[messageType] || NOTE_ASKS.Networking, me);

  return `${greet}\n\n${hookLine}${intro}\n\n${ask}\n\n${close}${me ? '\n' + me : ''}`;
}

// ─── Connection notes: LinkedIn cuts them off at 300 characters ───────────────
const NOTE_LIMIT = 300;
const NOTE_ASKS = {
  Networking:    `Would love to connect!`,
  Job:           `Would love to connect and hear about openings on your team.`,
  Referral:      `Would you be open to a quick chat about roles there?`,
  Collaboration: `Would love to connect and explore working together.`
};

// Builds the note from the most important parts down, dropping or trimming the
// least important part until it fits: intro → hook detail → sign-off.
function fitNote(greet, hookLine, intro, ask, me) {
  const build = (h, i, sign) => `${greet} ${h}${i} ${ask}${sign}`.replace(/\s+/g, ' ').trim();
  const sign  = me ? ` – ${me.split(' ')[0]}` : '';
  let note = build(hookLine, intro, sign);
  if (note.length > NOTE_LIMIT) note = build(hookLine, '', sign);
  if (note.length > NOTE_LIMIT) {
    const room = NOTE_LIMIT - build('', '', sign).length - 1;
    note = build(truncate(hookLine, Math.max(room, 40)), '', sign);
  }
  if (note.length > NOTE_LIMIT) note = build(truncate(hookLine, 60), '', '');
  return truncate(note, NOTE_LIMIT);
}

// Turns a hook ("Recent post: …", "Studied at …") into an opening sentence.
function hookToSentence(h) {
  let m;
  if ((m = h.match(/^You both studied at (.+)$/))) return `I noticed we're both from ${m[1]}!`;
  if ((m = h.match(/^You both worked at (.+)$/)))  return `I noticed we've both spent time at ${m[1]}.`;
  if ((m = h.match(/^You both work with (.+)$/)))  return `I noticed we both work with ${m[1]}.`;
  if ((m = h.match(/^You're both based in (.+)$/))) return `I noticed we're both based in ${m[1]}.`;
  if ((m = h.match(/^Recent post: "(.*)"$/)))      return `I enjoyed your recent post — "${truncate(m[1], 70)}".`;
  if ((m = h.match(/^Works as (.+) at (.+)$/)))    return `I came across your work as ${m[1]} at ${m[2]} and was impressed.`;
  if ((m = h.match(/^Currently at (.+)$/)))        return `I noticed you're currently at ${m[1]}.`;
  if ((m = h.match(/^Skilled in (.+)$/)))          return `Your experience in ${m[1]} caught my attention.`;
  if ((m = h.match(/^Previously at (.+)$/)))       return `I saw your journey through ${m[1]} — really interesting path.`;
  if ((m = h.match(/^Studied at (.+)$/)))          return `I noticed you studied at ${m[1]}.`;
  if ((m = h.match(/^Headline: (.+)$/)))           return `Your profile — "${truncate(m[1], 70)}" — caught my attention.`;
  return `Something on your profile stood out to me: ${h.replace(/\.$/, '')}.`;
}

// ─── AI message writer (uses the user's OWN key) ──────────────────────────────
async function aiMessage(apiKey, p, hooks, messageType, tone, settings = {}) {
  const isNote = settings.format === 'note';
  const shape  = isNote
    ? `a LinkedIn connection request note. HARD LIMIT: ${NOTE_LIMIT - 20} characters including spaces — LinkedIn cuts off anything longer. One short paragraph, greeting with first name, sign off with only the sender's first name.`
    : 'a LinkedIn direct message (under 600 characters), short paragraphs.';
  const prompt =
`Write ${shape}
Purpose: ${messageType}. Tone: ${tone}.
Recipient profile: ${JSON.stringify({
    name: p.name, headline: p.headline, title: p.currentTitle, company: p.currentCompany,
    about: truncate(p.about, 400), recentPosts: p.recentPosts, skills: p.skills
  })}
Open with these personalisation hooks (in this order of priority): ${hooks.join(' | ') || '(none — use the most specific detail in the profile)'}
Sender name: ${settings.userName || '(not given)'}. Sender bio: ${settings.userBio || '(not given)'}.
${settings.resumeProfile ? `Sender background from their résumé: ${JSON.stringify(settings.resumeProfile)}
If a hook starts with "You both", mention that shared background naturally in the first line — it is the strongest reason to reply.` : ''}
Return only the message text, nothing else.`;
  let text = (await callClaude(apiKey, prompt, 400)).trim();

  // Models miscount characters — if a note is still too long, ask once to shorten it
  if (isNote && text.length > NOTE_LIMIT) {
    text = (await callClaude(apiKey,
      `Shorten this LinkedIn connection note to under ${NOTE_LIMIT - 30} characters. Keep the opening hook and the ask. Return only the note.\n\n${text}`,
      200)).trim();
  }
  return text;
}

// `prompt` is a string, or an array of content blocks (e.g. a PDF document + text)
async function callClaude(apiKey, prompt, maxTokens) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `API error (${res.status})`);
  return (data.content || []).map(c => c.text || '').join('');
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function getApiKey() {
  return new Promise(resolve => {
    chrome.storage.local.get(['userApiKey'], r => resolve((r.userApiKey || '').trim()));
  });
}
function truncate(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function stringify(x) { return typeof x === 'string' ? x : (x?.school || x?.name || x?.title || Object.values(x || {}).join(', ')); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function storageGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function toList(x) { return Array.isArray(x) ? x.map(String).map(s => s.trim()).filter(Boolean) : []; }
