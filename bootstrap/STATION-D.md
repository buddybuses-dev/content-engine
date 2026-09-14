# Station D

How the content engine sits on the Windows machine, and why it is laid out this way.

## Layout

```
D:\ContentEngine\
├── repo\                          the git clone — everything tracked lives here
│   └── media\                     junctions pointing at ..\media\* (see below)
├── media\
│   ├── inbox\
│   │   ├── clipvault-agency\      drop exports here, named <item-id>.mp4
│   │   ├── wealthvault-insider\
│   │   ├── ai-benefits\
│   │   └── mymixvault\
│   ├── broll\<channel>\           background clips for the ffmpeg renderer
│   ├── music\<channel>\           background music beds
│   └── out\<channel>\             finished renders
├── archive\                       anything you want to keep but not track
└── logs\                          local run logs
```

**Media lives outside the clone**, with directory junctions pointing into it. Two
reasons: a large export can never be accidentally committed, and re-cloning or resetting
the repo never touches work in progress. Junctions are used rather than symlinks because
they need no administrator rights.

**One room per channel.** B-roll that suits a Whop product review is wrong for a channel
built on surprising facts, and one shared folder guarantees the wrong clip ends up on
the wrong channel eventually.

**A file one level up is shared.** Anything sitting in `media\broll\` itself is used by
any channel that has none of its own — put generic footage there and channel-specific
footage in the channel folder. The same fallback applies to `inbox`, so an export
dropped in the flat folder is still picked up.

Folders are created for you: `bootstrap-windows.ps1` does it at setup, and
`npm run source` does it for any channel you add later.

## Install

```powershell
cd D:\
# get the bootstrap script (or copy it off the repo)
.\bootstrap-windows.ps1
```

Re-running it is safe — it updates an existing clone instead of replacing it and never
overwrites `.env`.

```powershell
.\bootstrap-windows.ps1 -Root E:\ContentEngine   # different drive
.\bootstrap-windows.ps1 -RegisterTask            # also add the hourly local task
```

## The daily loop

The engine runs on GitHub Actions whether or not this machine is on. Station D is for
the one thing Actions cannot do: editing video.

1. GitHub Actions sources and scripts. Items land in `queue/03-render/`.
2. `git pull` in `D:\ContentEngine\repo` to see what needs a video.
3. `ls queue\03-render` gives you the item ids. Each JSON file holds the hook, the
   beats with their on-screen text, and the voiceover.
4. Cut the video. Export as `D:\ContentEngine\media\inbox\<item-id>.mp4`.
5. `npm run render` claims it and moves the item to `04-ready`.
6. `git add queue && git commit && git push` — Actions publishes it at the next window.

If you would rather skip steps 2 to 6 entirely, set the repository variable
`RENDERER` to `ffmpeg`, add b-roll to `media/broll/`, and the pipeline never needs
this machine at all.

## Running against local 9router

If 9router is running on this machine, put this in `repo\.env`:

```
LLM_BASE_URL=http://localhost:20128
```

Scripting then goes through your local gateway and its provider accounts instead of
calling Anthropic directly. This only affects local runs — a GitHub runner cannot reach
your localhost, so Actions always uses `ANTHROPIC_API_KEY` directly.

## Keeping this separate from other work on D:

Everything the engine touches is under `D:\ContentEngine\`. It creates no files
elsewhere, writes nothing to other folders on the drive, and reads only from its own
`media\` tree. Point `-Root` somewhere else if that path is already taken.
