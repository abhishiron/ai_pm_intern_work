# LinkedIn Outreach AI: improved

A Chrome extension that writes a personalised LinkedIn outreach message for the profile you're viewing.
This repo starts from the extension **exactly as received** and adds one improvement per commit, so each change can be reviewed on its own.

## What I changed and why

| # | Commit | Problem in the original | What it does now |
|---|--------|-------------------------|------------------|
| 1 | **Fix job-title scraping** | The "is this a date?" check matched month names *anywhere* in a line, so titles like **Mar**keting Manager, Sales Re**present**ative or D**oct**or were thrown away. Jobs were assumed to be exactly 3–4 lines, and locations were detected with a hard-coded list of Indian cities. On a sample profile, all 4 jobs came out wrong. | Dates must *start* the line. Each job is read line by line (title, company, then date and location lines), and a look-ahead stops "Founder, CEO" being mistaken for a place. 4/4 correct on the same sample. |
| 2 | **Make Deep Mode honest and useful** | Deep Mode showed a "3-layer OpenAI pipeline" with web enrichment, but nothing called OpenAI or the web. A 300 ms timer faked the work, and the result matched Quick Mode. | The steps describe what actually happens. With a key, Claude picks the 3 most specific hooks; without one, the UI says rules are used. Hooks are toggles, so you choose what goes into the message. |
| 3 | **Use the résumé: find common ground** | The résumé upload was saved (up to 4 MB) and never used. | Claude reads the PDF once and stores a small summary (schools, companies, skills, locations). Every profile is checked for shared background ("You both studied at IIM Bangalore", which also matches "Indian Institute of Management Bangalore"). Common ground becomes the top hook, labelled in Deep Mode. |
| 4 | **Fit LinkedIn's length limits** | Messages were up to ~600 characters, but LinkedIn connection notes are cut off at 300. | A *Connection note / Message* toggle. Notes are built to fit 300 (Claude is asked for less and shortens once if needed; templates drop the least important parts first). A live `n / 300` counter turns amber, then red. |
| 5 | **Clean-up and honest privacy note** | Leftovers from a paid version: license checks, a "messages left today" counter, unused background handlers. The settings said "no data is sent" even when AI Mode sends the profile to the API. | Dead code removed, version 3.2.0, and the privacy note says exactly what leaves the browser and when. |

## Install (unpacked)

1. Download this repo (Code → Download ZIP) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder.
4. Open a LinkedIn profile (`linkedin.com/in/…`) and click the extension icon.

**Free Mode** works with no setup. For **AI Mode**, add your own Anthropic API key under *Settings* and upload your résumé (PDF).

## How it works

- `content_script.js` reads the profile from the LinkedIn page.
- `background.js` finds hooks (rules, or Claude in AI Mode), matches common ground with your résumé, and writes the message (template or Claude), keeping notes under 300 characters.
- `popup.html / popup.js / popup.css` hold the UI: Quick and Deep modes, hook toggles, the format toggle, the counter and settings.
- `utils/cache.js` keeps your last 5 contacts locally.

All data stays in `chrome.storage.local`. In AI Mode, the profile (and your résumé, once) goes to `api.anthropic.com` using your own key.
