# Model Freshness Tracker

How fresh are the top AI models? One page, seven labs, days since release —
and a prompt to run every time a new model drops.

**Live site:** https://canoo.github.io/ModelFreshness/

## What it is

A static page that lists the flagship models from Anthropic, OpenAI, Google,
xAI, Meta, DeepSeek and Mistral with their release dates and a freshness band:

| Band | Days since release | Colour |
| --- | --- | --- |
| FRESH | 0–14 | green |
| WARM | 15–60 | amber |
| COOLING | 61–180 | orange |
| STALE | 181+ | red |

It also carries the new-model health-check prompt (Anthropic's Alex Albert):
every time a new model lands, run it on all your projects — it finds what's
broken, inconsistent, inefficient or no longer needed, fixes what it's sure
about, and lists the rest for you to review.

## Which model for what — analytical notes

Below the freshness list, the page has a "Which model for what" section,
rendered from `data/model-notes.json` (dated Nov 13, 2026). For each of the
9 task categories — everyday coding, hard engineering, planning,
orchestration, quick routine jobs, deep reasoning, writing, data analysis,
agentic work — it shows the best pick, alternatives, and a per-subscription
block (Google-only, OpenAI-only, Claude-only) with the honest gap versus
the cross-provider best pick. Every model row also expands to show its
`best_for` / `avoid_for`, pricing and strengths, with source links.

**Sourcing method:** picks are grounded first in what each vendor says in
its own changelog or announcement — the company's stated intent for the
model. Benchmarks are secondary and subjective; where a score disagrees
with the vendor's positioning the disagreement is flagged and the pick
still follows vendor intent. Anything that could not be verified is shown
in the UI as "unverified" and never asserted as fact.

**Scores policy:** every score on the page is cited individually with
source, link and date. Artificial Analysis figures are not shown on the site. Vendor-reported numbers are
labelled as such and lead. LMArena leaderboards and Epoch AI data are
CC BY 4.0 and freely reusable with attribution — LMArena figures appear
where used, with the note that they measure human preference (Elo votes),
not task completion. No composite score is ever computed from different
sources.

`data/model-notes.json` is updated by hand, not auto-updated: the daily
fetch script does not mirror it yet, so copy `data/model-notes.json` to
`web/model-notes.json` by hand when the notes change, and commit both
together.

## Architecture

```
data/models.json          the data (labs, models, release dates, prompt section)
data/model-notes.json     analytical notes (categories, per-model best/avoid, sources)
data/overrides.json       manual entries + known source disagreements
scripts/fetch-models.mjs  daily updater — pulls models.dev, diffs, writes data
web/index.html            the page — single static file, fetches models.json
web/models.json           copy of the data, kept in sync by the fetch script
web/model-notes.json      copy of the notes — sync by hand for now (see above)
.github/workflows/
  update-models.yml       daily fetch + auto-commit when data changes
  deploy-pages.yml        publishes web/ to GitHub Pages on push
```

No backend, no database, no sign-in. The page is static; the automation is
a scheduled script that commits data changes.

## How updates work

1. Every day at 05:30 MST, `update-models.yml` runs `node scripts/fetch-models.mjs`.
2. The script fetches `https://models.dev/api.json` — a public model catalog
   with `release_date` per model, no API key needed — and diffs it against
   `data/models.json`.
3. New models matching a lab's watchlist (flagship text models released in
   the last 180 days) are added. Recent-but-unmatched models are printed as
   candidates for a human to review, not auto-added.
4. If the data changed, the workflow commits `data/models.json` and
   `web/models.json` to `main` and Pages redeploys. If nothing changed,
   nothing is committed.

The script **never deletes a model and never re-dates one** unless run with
`--allow-redate`. A source that disagrees with a stored date is reported as
a conflict and the stored date wins. Manual entries (`source: "manual"`)
are never touched by the script.

To switch the daily update from auto-commit to pull requests, replace the
"Commit data changes" step in `update-models.yml` with
`peter-evans/create-pull-request@v6` (or similar) — the fetch step is
unchanged.

## Sources — what is actually fetchable

| Source | Usable? | Notes |
| --- | --- | --- |
| models.dev `api.json` | Yes — primary | Public JSON, no key. Covers 6 of 7 labs well. |
| Vendor changelogs (OpenAI, Anthropic, Google, xAI, Meta, DeepSeek, Mistral) | No | HTML pages, no stable JSON API. Scraping them breaks constantly. |
| Artificial Analysis / Evertune tracker | No | Benchmark/news pages, HTML-only, no keyless JSON. |

When models.dev misses a release, add it by hand: put the entry in
`data/overrides.json` (with the reason) and in `data/models.json` with
`"source": "manual"`.

Known models.dev gaps, documented in `data/overrides.json`:

- Meta's Llama 4 Scout / Maverick, Muse Glimmer and Muse Spark Open are
  not in models.dev's catalog.
- Gemini 3 Pro and OpenAI's Cyber are not in models.dev either.
- models.dev's date for Claude Sonnet 4.6 (2026-02-17) is wrong — Anthropic's
  own announcement is 2026-11-08, which is what the tracker stores.
- GPT-6 Astra: models.dev says 2026-09-04, tracker stores 2026-09-03
  (OpenAI's changelog). One day apart, unresolved.

## Adding a lab or a model

1. Add the model to `data/models.json` under its lab, newest first, with
   `release` as `YYYY-MM-DD` (or `YYYY-MM` if only the month is known,
   with `"note": "month-level, approximate"`).
2. If it has a models.dev id, add `"models_dev_id": "<id>"` and
   `"source": "models.dev"`. If models.dev doesn't list it, use
   `"source": "manual"` and record the reason in `data/overrides.json`.
3. Run `node scripts/fetch-models.mjs --dry-run` to check nothing conflicts.
4. The fetch script also mirrors the data to `web/models.json` — commit both
   files together.

## Run it locally

```sh
node scripts/fetch-models.mjs            # update data (dry-run with --dry-run)
node scripts/fetch-models.mjs --dry-run  # print the summary, change nothing
cd web && python3 -m http.server 8000    # then open http://localhost:8000
```

Node 18+ (uses the built-in `fetch`). No dependencies, no install step.

## Cost

$0. GitHub Pages and GitHub Actions (public repo) are free at this usage.
models.dev's `api.json` is public and keyless. Nothing here calls a paid API.
