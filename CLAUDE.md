# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A 24/7 short-form content pipeline. It sources vetted Whop products, writes UGC scripts
with Claude, renders vertical video, and publishes to YouTube Shorts, Instagram Reels
and TikTok — driven entirely by scheduled GitHub Actions.

## The one idea to understand first

**The queue is the database.** Every content item is a single JSON file under
`queue/<channel>/<stage>/`, and moving between stages is a file move that git records.
There is no external database, no state service, and no dashboard. This is why the
pipeline is cheap to run forever and why its whole history is inspectable with `git log`.

The queue is partitioned **by channel first, then by stage**. One channel's backlog can
never be confused with another's, a channel is paused by not iterating it, and
`git log queue/ai-benefits/` tells that channel's whole story without noise.

Consequences worth holding onto:

- Any stage can be re-run safely; they are all idempotent.
- Workflows commit the queue back to the branch, so they share a `content-queue`
  concurrency group and must never run in parallel.
- Debugging is `cat` and `jq`, not log aggregation.

## Channels

Each channel is one file in `config/channels/`. **The filename is the slug**, and it is
load-bearing in three places — the queue path, the credential suffix, and the logs:

```
config/channels/wealthvault-insider.json
  → queue/wealthvault-insider/…
  → YOUTUBE_REFRESH_TOKEN_WEALTHVAULT_INSIDER
```

Adding a channel is adding a file. There is no registration list to update and no
workflow to edit — `lib/channels.js` globs the directory, and the workflows export
every repository secret rather than naming them one by one, precisely so that adding a
channel never requires touching `.github/`.

Credentials resolve channel-specific first, shared second (`channelEnv` /
`requireChannelEnv`). Never call `required()` for a platform credential — it cannot see
the channel, and a four-channel setup will silently use the wrong account.

Every stage iterates channels in a `try`/`catch` per channel. **One channel's failure
must never stop the others.** That is deliberate and load-bearing; preserve it.

## Flow

```
config/channels/<slug>.json
  → 1-source   → queue/<slug>/01-brief      (vetted product becomes a brief)
  → 2-script   → queue/<slug>/03-render     (Claude writes script + 3 platform captions)
  → 3-render   → queue/<slug>/04-ready      (video file produced or claimed)
  → 4-publish  → queue/<slug>/05-published  (YouTube + Instagram + TikTok)
  → 5-stats                                 (performance written back onto the item)
```

`02-script/` exists for symmetry but is transient — scripting writes straight through to
`03-render`. An item sitting in `02-script` means something crashed mid-write.

## Layout

| Path | Role |
| --- | --- |
| `config/channels/` | One file per channel: identity, voice, cadence, compliance, product list. |
| `config/platforms.json` | Facts about YouTube/Instagram/TikTok. Not a per-channel choice. |
| `lib/` | Shared plumbing: queue, HTTP retry, LLM, env, TTS, media hosting. |
| `pipeline/` | One file per stage. Each is an entry point with its own npm script. |
| `sources/` | Where content ideas come from. Whop today. |
| `renderers/` | How a script becomes a video. `manual` and `ffmpeg`. |
| `publishers/` | One file per platform. |
| `.claude/skills/` | Task-specific guidance — read the relevant one before working in an area. |

## Conventions

- Plain JavaScript, ESM, Node 20+. No TypeScript, no build step.
- **No new dependencies without a reason that survives scrutiny.** The only runtime
  dependency is `@anthropic-ai/sdk`; everything else uses Node built-ins. This is what
  keeps CI installs fast and the supply chain small.
- Behaviour belongs in `config/`, not in code. If you find yourself editing a prompt in
  `pipeline/2-script.js` to change a channel's tone, edit that channel's file instead.
- Credentials go through `lib/channels.js` (`channelEnv` / `requireChannelEnv`) so they
  resolve per channel. `lib/env.js` `required()` is only for genuinely global settings.
  Never read `process.env` directly.
- Errors move an item to `99-failed` with the reason attached. Never swallow an error
  and never delete a failed item — triage is a human decision.
- `DRY_RUN=1` must keep every stage from touching an external service. Any new code
  path that spends money or posts publicly has to honour it.

## Model usage

`lib/llm.js` is the only place that calls a model. It defaults to `claude-opus-5` with
adaptive thinking and structured outputs, and can be pointed at a local 9router gateway
with `LLM_BASE_URL` for runs on station D. Add generative steps there, not inline.

## Safety rails that must not be weakened

- `appendDisclosure()` prepends the affiliate disclosure **after** generation, so the
  model cannot reword or drop it. Do not move disclosure into the prompt.
- `bannedClaimPatterns` are checked against all generated text. They exist to keep the
  accounts alive; extend them, do not relax them.
- Cadence limits are enforced inside `4-publish.js`, not by the cron schedule, so a
  manual run cannot exceed them.
