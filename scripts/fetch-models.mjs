// fetch-models.mjs — Model Freshness Tracker updater.
//
// Pulls model release info from public sources and updates data/models.json.
//
//   node scripts/fetch-models.mjs [--allow-redate] [--dry-run]
//
//   --allow-redate   permit changing an existing model's release date.
//                    Without it, a source that disagrees with a stored date
//                    is reported as a CONFLICT and the stored date wins.
//   --dry-run        print the summary, do not write any file.
//
// What is actually fetchable (checked 2026-11-13):
//   - models.dev publishes a full catalog as JSON, no key needed:
//       https://models.dev/api.json
//     Every model entry carries `release_date` and `last_updated`.
//     This is the script's primary source. It covers 6 of our 7 labs well;
//     Meta's open-weight and older Muse models are missing from it (see
//     data/overrides.json), and two of its dates are wrong (see below).
//   - Vendor changelogs / release pages (OpenAI, Anthropic, Google, xAI,
//     Meta, DeepSeek, Mistral) are HTML pages with no stable JSON API.
//     They are NOT fetched — scraping them breaks constantly and the
//     tracker would silently go stale. When models.dev misses a release,
//     add it by hand to data/overrides.json and it is picked up here.
//   - Artificial Analysis and Evertune's tracker are benchmark/news pages,
//     also HTML-only, no keyless JSON. Same treatment as vendor pages.
//
// Known models.dev date errors (do NOT "fix" the stored dates from it):
//   - claude-sonnet-4-6: models.dev says 2026-02-17. Anthropic's own
//     announcement ("Introducing Sonnet 4.6") is dated 2026-11-08.
//     models.dev is wrong; the stored date is right.
//   - gpt-6-astra: models.dev says 2026-09-04, stored date is 2026-09-03.
//     One day apart; the stored date came from OpenAI's changelog.
//   - mistral-medium-2604 / mistral-small-2603 carry exact dates
//     (2026-04-29 / 2026-03-16) while the tracker stores month-level
//     dates ("2026-04" / "2026-03", marked approximate). The script
//     reports these as refinements; it never rewrites a month-level date
//     on its own.
//
// Rules:
//   - Never delete a model. Never re-date an existing model without
//     --allow-redate. Manual entries (source "manual") are never touched.
//   - New models are auto-added ONLY if they match a lab's watchlist
//     pattern AND were released in the last 45 days. Everything else
//     recent-but-unmatched is printed as a CANDIDATE for a human to add.
//   - Exit 0 on success (even with conflicts/candidates — those are
//     printed, not fatal). Exit non-zero only when the fetch itself
//     failed or the local data file is unreadable/invalid.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = path.join(ROOT, 'data', 'models.json');
const WEB_COPY = path.join(ROOT, 'web', 'models.json');
const MODELS_DEV_URL = 'https://models.dev/api.json';
// Only releases from the last 45 days are auto-added or surfaced. The
// daily job runs every day, so 45 days is plenty — anything older than
// that when the job first runs is history the curator already decided
// about (a wider window would backfill whole previous generations).
const RECENT_DAYS = 45;

const args = new Set(process.argv.slice(2));
const ALLOW_REDATE = args.has('--allow-redate');
const DRY_RUN = args.has('--dry-run');

// models.dev provider key per lab.
const PROVIDER = {
  Anthropic: 'anthropic',
  OpenAI: 'openai',
  Google: 'google',
  xAI: 'xai',
  Meta: 'meta',
  DeepSeek: 'deepseek',
  Mistral: 'mistral',
};

// Watchlist: which models.dev entries count as tracker-worthy new models
// for each lab. Dated snapshots (ids ending in a date), "-latest" aliases,
// preview/image/tts/live/vision/contributor variants and mini/nano tiers
// are excluded — they print as candidates instead of being auto-added.
const WATCHLIST = {
  Anthropic: /^claude-(opus|sonnet|haiku|fable)-[0-9]/,
  OpenAI: /^gpt-[0-9]/,
  Google: /^gemini-[0-9]/,
  xAI: /^grok-[0-9]/,
  Meta: /^muse-[a-z]|^llama-[0-9]/,
  DeepSeek: /^deepseek-/,
  Mistral: /^mistral-(large|medium|small)/,
};
const EXCLUDE_ID = /(-\d{8}$|-latest$|-preview$|-image$|-tts$|-live$|-vision$|-exp$|-contributor$|-mini$|-nano$|-code$|-fast$)/;

// Brand prefixes per lab: candidates are only surfaced for the lab's own
// models. models.dev providers are reseller catalogs — e.g. the mistral
// provider also lists GLM and DeepSeek re-exports, which are not Mistral
// models and would otherwise flood the candidate list.
const BRAND = {
  Anthropic: /^claude-/,
  OpenAI: /^(gpt|chatgpt|o[0-9]|codex|daybreak)-/,
  Google: /^gemini-/,
  xAI: /^grok-/,
  Meta: /^(muse|llama)-/,
  DeepSeek: /^deepseek-/,
  Mistral: /^(mistral|devstral|magistral|voxtral|codestral)-/,
};

// Same release date + same name once digits are stripped means the same
// model under two ids (e.g. "DeepSeek V4 Flash" vs "V4.1 Flash 1017", or
// "Mistral Large 4.0.8" vs "Large 4"). Treated as a duplicate, not a new
// model. A genuinely different model released the same day with a name
// that reduces to the same words would also be caught — it then just
// needs a human to add it by hand, which is the safe failure mode.
function sameModel(a, b) {
  const strip = (s) => s.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const x = strip(a);
  const y = strip(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const daysAgo = (iso) => Math.floor((today - new Date(iso + 'T00:00:00Z')) / 86400000);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
} catch (err) {
  fail(`cannot read ${DATA_PATH}: ${err.message}`);
}
if (!Array.isArray(data.labs)) fail(`${DATA_PATH} has no labs array`);

console.log(`Fetching ${MODELS_DEV_URL} ...`);
let catalog;
try {
  const res = await fetch(MODELS_DEV_URL, {
    headers: { 'user-agent': 'ModelFreshness/1.0 (+https://github.com/canoo/ModelFreshness)' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) fail(`models.dev returned HTTP ${res.status}`);
  catalog = await res.json();
} catch (err) {
  fail(`fetch failed: ${err.message}`);
}

const summary = { added: [], conflicts: [], missing: [], duplicates: [], candidates: [], refinements: [], checked: 0 };

for (const lab of data.labs) {
  const providerKey = PROVIDER[lab.company];
  const provider = catalog[providerKey];
  if (!provider || !provider.models) {
    console.log(`  [${lab.company}] provider "${providerKey}" not in models.dev — skipped`);
    continue;
  }
  const models = provider.models;
  const trackedById = new Map();
  for (const m of lab.models) {
    if (m.models_dev_id) trackedById.set(m.models_dev_id, m);
  }

  // 1. Check every tracked model that has a models.dev id.
  for (const [devId, tracked] of trackedById) {
    summary.checked += 1;
    const entry = models[devId];
    if (!entry) {
      summary.missing.push(`${lab.company} / ${tracked.name}: no longer in models.dev (kept, manual check)`);
      continue;
    }
    const remote = entry.release_date;
    if (!remote) {
      summary.missing.push(`${lab.company} / ${tracked.name}: models.dev has no release_date (kept)`);
      continue;
    }
    const stored = tracked.release;
    if (/^\d{4}-\d{2}$/.test(stored)) {
      // Month-level stored date: an exact remote date is a refinement, not a conflict.
      if (remote.startsWith(stored)) {
        summary.refinements.push(`${lab.company} / ${tracked.name}: stored "${stored}" (approx) — models.dev has exact ${remote}; use --allow-redate to apply`);
      } else {
        summary.conflicts.push(`${lab.company} / ${tracked.name}: stored "${stored}" vs models.dev ${remote} (stored wins)`);
      }
      continue;
    }
    if (remote !== stored) {
      summary.conflicts.push(`${lab.company} / ${tracked.name}: stored ${stored} vs models.dev ${remote} (stored wins${ALLOW_REDATE ? ' — re-dating' : ''})`);
      if (ALLOW_REDATE) {
        tracked.release = remote;
        summary.added.push(`${lab.company} / ${tracked.name}: release re-dated ${stored} -> ${remote}`);
      }
    }
  }

  // 2. Discover new models from this provider.
  const trackedNames = new Set(lab.models.map((m) => m.name.toLowerCase()));
  const trackedIds = new Set(trackedById.keys());
  for (const [id, entry] of Object.entries(models)) {
    if (trackedIds.has(id)) continue;
    const name = entry.name || id;
    if (trackedNames.has(name.toLowerCase())) continue;
    if (!entry.release_date) continue;
    const age = daysAgo(entry.release_date);
    if (age < 0 || age > RECENT_DAYS) continue; // not new, or future-dated data
    const watch = WATCHLIST[lab.company];
    const clean = watch.test(id) && !EXCLUDE_ID.test(id);
    const isDuplicate = lab.models.some(
      (m) => m.release === entry.release_date && sameModel(m.name, name),
    );
    if (isDuplicate) {
      summary.duplicates.push(`${lab.company} / ${name} (${id}): same release date as a tracked model with the same name — treated as a duplicate id, not added`);
      continue;
    }
    if (clean) {
      lab.models.unshift({
        name,
        release: entry.release_date,
        source: 'models.dev',
        models_dev_id: id,
      });
      summary.added.push(`${lab.company} / ${name}: added, released ${entry.release_date}`);
    } else if (BRAND[lab.company].test(id)) {
      summary.candidates.push(`${lab.company} / ${name} (${id}): released ${entry.release_date} — needs human review`);
    }
  }

  // Keep newest first within each lab.
  lab.models.sort((a, b) => (b.release < a.release ? -1 : b.release > a.release ? 1 : 0));
}

console.log('');
console.log('--- fetch-models summary ---');
console.log(`Checked ${summary.checked} tracked models against models.dev.`);
for (const line of summary.added) console.log(`  ADDED:      ${line}`);
for (const line of summary.conflicts) console.log(`  CONFLICT:   ${line}`);
for (const line of summary.refinements) console.log(`  REFINEMENT: ${line}`);
for (const line of summary.missing) console.log(`  MISSING:    ${line}`);
for (const line of summary.duplicates) console.log(`  DUPLICATE:  ${line}`);
for (const line of summary.candidates) console.log(`  CANDIDATE:  ${line}`);
if (!summary.added.length && !summary.conflicts.length && !summary.candidates.length) {
  console.log('  No changes. Data is up to date.');
}

const changed = summary.added.length > 0;
const webCopyMissing = !existsSync(WEB_COPY);
if (changed || webCopyMissing) {
  data.updated_at = changed ? today.toISOString().slice(0, 10) : data.updated_at;
  const text = JSON.stringify(data, null, 2) + '\n';
  if (DRY_RUN) {
    console.log('(dry run — no files written)');
  } else {
    writeFileSync(DATA_PATH, text);
    writeFileSync(WEB_COPY, text);
    console.log(`Wrote ${DATA_PATH} and ${WEB_COPY} (updated_at ${data.updated_at}).`);
  }
} else if (DRY_RUN) {
  console.log('(dry run — no files written)');
} else {
  console.log('No file changes.');
}
