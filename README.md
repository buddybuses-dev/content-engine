# content-engine

Automasjonskanal for UGC-innhold: fra vettet Whop-produkt til publisert video på
YouTube Shorts, Instagram Reels og TikTok — uten at PC-en din trenger å stå på.

Motoren er GitHub Actions. Køen er git. Ingen server, ingen database, ingen abonnement
utover API-nøklene.

---

## Hvordan det henger sammen

```
config/channels/<kanal>.json   ← her bestemmer du hva som skal lages, per kanal
        │
        ▼
   1-source      Produkt blir til en brief            → queue/<kanal>/01-brief
   2-script      Claude skriver manus + 3 captions    → queue/<kanal>/03-render
   3-render      Manus blir til video                 → queue/<kanal>/04-ready
   4-publish     Video ut på alle tre plattformer     → queue/<kanal>/05-published
   5-stats       Tall skrives tilbake på videoen
```

Hvert innholdselement er **én JSON-fil** som flytter seg mellom mappene i
`queue/<kanal>/`. Hele historikken ligger i git, alt kan feilsøkes med `cat` og `jq`,
og et hvilket som helst steg kan trygt kjøres på nytt.

## Flere kanaler

Hver kanal er **én fil** i `config/channels/`. Filnavnet er slug-en, og den går igjen
tre steder — kø-stien, credential-suffikset og loggene:

```
config/channels/wealthvault-insider.json
  → queue/wealthvault-insider/
  → YOUTUBE_REFRESH_TOKEN_WEALTHVAULT_INSIDER
```

Å legge til en kanal er å legge til en fil. Ingen kode, ingen registreringsliste, ingen
endring i workflowene. Å pause en kanal er `"enabled": false`.

Kanalene er helt uavhengige: egen kø, egen stemme, egen produktliste, egen kadens, egne
credentials. Én kanal med utløpt token feiler alene — de tre andre publiserer videre.

Credentials følger én regel: **kanal-spesifikk vinner, delt er fallback.**

```
YOUTUBE_REFRESH_TOKEN_WEALTHVAULT_INSIDER   ← denne kanalen
YOUTUBE_REFRESH_TOKEN                       ← alle kanaler uten egen
```

Bruk delt form for det som faktisk deles (Anthropic-nøkkel, OAuth-klient) og suffiks for
alt som identifiserer én konto (alle refresh-tokens). `npm run health` skriver ut
nøyaktig hvilket variabelnavn hver kanal mangler.

## Kom i gang

```bash
npm install
cp .env.example .env          # fyll inn nøkler — se docs/SETUP.md
npm run dry                   # hele syklusen uten å røre noe eksternt
```

Deretter, i denne rekkefølgen:

1. **Gå gjennom `config/channels/`** — fire kanaler ligger der. Én er live
   (`wealthvault-insider`), tre er `"enabled": false` med nisje og stemme jeg har
   gjettet ut fra navnet. Rett dem før du skrur dem på.
2. **Legg inn minst ett produkt** under `sources.manualProducts` i kanalens fil, med
   `enabled: true`. Les `.claude/skills/whop-ugc-sourcing/SKILL.md` først — den
   beskriver hva som faktisk er verdt å lage video om.
3. **Legg nøklene inn som GitHub-secrets** (`docs/SETUP.md` går gjennom hver enkelt).
4. **Kjør workflowen `Pipeline` manuelt** med `dry_run` huket av, og se at den grønner.

## Kommandoer

| Kommando | Hva den gjør |
| --- | --- |
| `npm run source` | Henter nye produkter og lager briefer |
| `npm run script` | Skriver manus og captions med Claude |
| `npm run render` | Lager eller henter videofila |
| `npm run publish` | Publiserer neste ferdige video |
| `npm run stats` | Henter tall på publiserte videoer |
| `npm run health` | **Start her når noe er galt** — viser kødybde og alt som blokkerer |
| `npm run cycle` | Hele produksjonssyklusen |
| `npm run dry` | Samme, men uten å røre noen ekstern tjeneste |

## Rendering: to måter

`RENDERER=manual` (standard) — pipelinen venter på at du slipper en eksport inn i
`media/inbox/<item-id>.mp4`. Klipp i Crayo, Descript, OpenCut, CapCut — hva du vil.
Elementer uten fil blir liggende i `03-render`, og det er **ikke** en feil.

`RENDERER=ffmpeg` — helautomatisk: ElevenLabs leser inn manuset, ffmpeg legger det over
en b-roll-klipp fra `media/broll/`, brenner inn captions og mikser musikk under.
Kjører på GitHub sine runnere uten oppsett.

## Rytme og sikkerhetsnett

Grensene i `config/channel.config.json` håndheves **inne i publiseringssteget**, ikke av
cron. Det betyr at en manuell kjøring aldri kan presse kanalen forbi dagsgrensen.

- Affiliate-disclosure legges på **etter** at modellen er ferdig, så den kan ikke
  skrives bort.
- `bannedClaimPatterns` blokkerer garantier, «risk-free» og gangeklaimer — det er de
  formuleringene som får kontoer begrenset.
- `health.yml` kjører hver morgen og åpner en issue hvis kanalen er i ferd med å bli
  stille. En stille kanal som ingen oppdager er den dyreste feilen som finnes her.

## Dokumentasjon

| Fil | Innhold |
| --- | --- |
| `docs/SETUP.md` | Hver eneste nøkkel, steg for steg |
| `docs/ARCHITECTURE.md` | Hvorfor det er bygget slik |
| `bootstrap/STATION-D.md` | Oppsett på D:-stasjonen på Windows |
| `.claude/skills/` | Seks skills — sourcing, manus, render, publisering, tall, triage |
| `CLAUDE.md` | Instruksjoner for Claude Code i denne repoen |

## Når noe ryker

```bash
npm run health
```

Den navngir problemet i klartekst. Deretter:
`.claude/skills/pipeline-triage/SKILL.md`.
