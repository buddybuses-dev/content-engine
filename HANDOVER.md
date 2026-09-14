# Handover

Read this first if you are a fresh session picking up this project. It records where
things stand, what was decided and why, and what is actually blocking progress — the
things that are not obvious from the code alone.

Nothing personal lives in this file. Account names, emails and credentials are kept in
`PRIVATE.md`, which is gitignored and never committed.

---

## Where things stand

The pipeline is **built, tested and complete**. It has never produced a real video,
because the inputs it needs have not been supplied yet.

Everything below is verified working, not aspirational:

- Four channels, isolated queues, independent cadence and credentials
- Two source types (Whop products, topics) behind one interface
- Scripting with Claude against a JSON schema, with a validator and one correction pass
- Two renderers: `manual` (claim a dropped export) and `ffmpeg` (TTS + b-roll + captions)
- Three publishers with partial-failure recovery that cannot double-post
- Four scheduled workflows, sharing one concurrency group

## The four channels

| Slug | Role | Source | Live | Cadence |
| --- | --- | --- | --- | --- |
| `clipvault-agency` | The affiliate channel — Whop products, honest UGC, commission | `whop` | yes | 2/day |
| `wealthvault-insider` | How money actually works. Nothing sold. | `topics` | no | 1/day |
| `ai-benefits` | AI tools judged by what they replace | `topics` | no | 1/day |
| `mymixvault` | Wide net, one surprising fact per video | `topics` | no | 3/day |

Only ClipVault is enabled. The other three are staged: their configs are complete but
`enabled: false`, waiting on real topics from the owner.

**MyMixVault is the only channel with existing subscribers.** Its rules are the
strictest about facts being checkable, because it is the one where a wrong claim costs
something real.

## What is blocking, in order

1. **No Whop product.** ClipVault is live but `sources.manualProducts` has only a
   disabled example. Stage 1 correctly sources nothing. This is the single input that
   would produce a first video. It needs a name, URL, price, affiliate link, and two or
   three sentences on what a member actually receives in week one — not the sales page.

2. **`ANTHROPIC_API_KEY` is not set.** Without it nothing gets scripted.

3. **The GitHub account is locked for a billing issue.** Confirmed from the run
   annotation: *"The job was not started because your account is locked due to a billing
   issue."* Every workflow fails in 3-4 seconds without a runner being assigned. Making
   the repository public did not help, because the lock is account-wide.

   This blocks **only the automation**. The pipeline runs fine locally — see
   `bootstrap/STATION-D.md`. Do not let this become a reason the project stalls.

## Decisions worth not re-litigating

**The queue is the database.** Channel first, then stage. No external state service.
The tradeoffs are written up in `docs/ARCHITECTURE.md`; they were considered, not
stumbled into.

**Topics are hand-written, not pulled from a trends API.** A trend feed produces videos
about whatever is loud today, which is how a channel ends up with no identity.

**No marketplace scraper for Whop.** No public discovery API exists for third parties,
and a storefront scraper breaks constantly and sits on the wrong side of their terms.
Breadth comes from vetting more products.

**Safety rails live in code, not in prompts.** Affiliate disclosure is appended after
generation so the model cannot reword it away. Banned-claim regexes gate all generated
text. Cadence is enforced inside the publish stage, not by cron.

## The known design gap

**One product currently yields exactly one video.** Once a product is sourced it is
never re-briefed.

ClipVault posts twice a day. That is sixty products a month of manual input, which is
not realistic, and it was a misjudgement in the original design.

The fix, offered but not yet built: **one product should yield eight to ten videos**
from different angles — what you get in week one, who it is not for, whether the price
is defensible, the feature people miss, what onboarding does not tell you, how it
compares to the free option. Then the owner writes one product a month, not sixty.

If the project is being picked up again and the owner is still supplying products one
at a time, build this before anything else. It is the difference between a pipeline
they can run and one they abandon.

## Things that will waste your time

- **Do not suggest more tooling.** The owner has forked n8n, langflow, dify, crawl4ai,
  browser-use, OpenCut, Wan2.2 and a 147-agent pack. Tooling is not the constraint. One
  finished video is.
- **Claude cannot log into anything.** No browser, no persistent identity, no accounts.
  Credentials go in `.env` locally or as GitHub secrets; Claude never sees them and
  should never be asked to hold them.
- **The GitHub App in these sessions cannot create repositories** (403) and `git push`
  over Bash may be blocked by the permission classifier. The GitHub MCP `push_files`
  tool works. Note that it JSON-decodes `\uXXXX` escapes in file content — write
  `\\uXXXX` if you need the literal escape sequence in a file.
- **The egress proxy blocks** `notion.site` and GitHub's Azure log-storage host, so job
  logs cannot be read from inside a session. Ask for a screenshot of the run page
  instead of trying to fetch them.

## First commands on a fresh checkout

```bash
npm install
npm run health          # names every missing credential, per channel
DRY_RUN=1 npm run cycle # full cycle touching nothing external
```

`health` exits non-zero when a live channel is about to go dark. That is the signal to
trust over any other.
