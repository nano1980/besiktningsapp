# Carspect Agent – Projektkontext för Claude

> Läs den här filen i början av varje session. Den beskriver exakt var projektet befinner sig och hur allt hänger ihop — du ska kunna fortsätta arbetet utan att användaren behöver förklara om från början.

---

## ⚠️ Arbetssätt – viktigt

**Fråga alltid om tillåtelse innan du editerar kod.** Presentera förslaget, förklara vad som ändras, och invänta ett "ja/kör" innan du rör filerna.

---

## Vad är det här?

**carspect-agent** är ett Node.js-verktyg som automatiserar sökning av besiktningstider på [carspect.se](https://www.carspect.se/boka-tid) med hjälp av **Playwright** (headless browser automation), och låter användaren slutföra bokningen i en inbyggd iframe.

Projektet finns lokalt på:
```
~/carspect-agent/
```

GitHub: https://github.com/nano1980/besiktningsapp

---

## Filstruktur

```
carspect-agent/
├── cli.js          – CLI-verktyg för att köra scraper från terminalen
├── scraper.js      – Playwright-automation för scraping (bookTimeslot finns kvar men används ej)
├── server.js       – Express REST API (port 3000)
├── index.html      – Frontend-UI (SPA, körs direkt som fil i webbläsaren)
├── package.json    – ESM-projekt, dependencies: playwright, express, cors
└── results/        – Sparade CSV-resultat från körningar
```

---

## Hur det fungerar – v1.1

### scraper.js

**`scrapeTimeslots({ reg, location })`** — används aktivt
- Startar **en** Chromium-instans, kör **3 parallella browser-contexts** (batcher)
- Varje batch väljer 5 stationer (carspect.se tillåter max 5 åt gången → 15 totalt)
- Blockerar CSS, bilder, fonts och analytics via `page.route()` för hastighet
- Reducerade timeouts: cookie-banner 1500ms, location-prompt 1000ms
- Diagnostic logger: loggar alla JSON-svar från carspect.se API:t (för framtida XHR-optimering)
- Returnerar `{ timeslots: [...], inspectionType, stations }`

**`bookTimeslot()`** — finns i koden men **anropas inte längre**. Kan städas bort i framtiden.

### server.js – Express API på port 3000

```
GET  /timeslots?reg=ABC123&location=Stockholm   → Returnerar lediga tider (JSON + sparar CSV)
POST /book  { reg, station, date, time }         → Öppnar carspect.se i ny webbläsarflik (exec open)
GET  /health                                     → { status: "ok" }
```

**OBS:** `/book` använder nu `exec('open "https://www.carspect.se/boka-tid"')` — ingen Playwright. Men frontend anropar inte längre `/book` heller (se nedan). Endpointen är kvar men används inte aktivt.

### index.html – Frontend SPA

Körs som `file:///Users/hernangil/carspect-agent/index.html` i webbläsaren.
Kommunicerar med Express-servern på `http://localhost:3000`.
Mobilanpassad app-layout (max-width 600px), 4 skärmar:

#### Skärm 1: Sök (`screen-search`)
- Registreringsnummer + stad (dropdown)
- **Senaste sökning-banner** (`#cached-banner`): visas när `state.slots.length > 0`, dvs. när användaren backat från resultatlistan. Klick navigerar direkt till resultatlistan utan ny sökning. Texten: "Visa X tider för REG i STAD".

#### Skärm 2: Resultat (`screen-results`)
- Visar alla timeslots sorterade efter datum/tid
- **Närmast i tid**-banner högst upp
- **Filtreringsfält** — realtidsfilter på stationsnamn (`#area-filter`)
- Klick på en tid → Bekräftelseskärm

#### Skärm 3: Bekräfta (`screen-confirm`)
- Visar detaljer: fordon, station, datum, tid, pris
- Knapp: **"Gå till bokning →"** → laddar carspect.se i iframe och visar Bokningsinfo-modalen

#### Skärm 4: Boka (`screen-payment`) — **iframe**
- Topbar med: bakåtknapp (‹) + "Boka tid / carspect.se" + **"Bokningsinfo"-knapp** (pill, höger)
- **`#booking-frame`**: iframe som laddar `https://www.carspect.se/boka-tid`
  - Laddas **bara en gång** (`src` sätts bara om den är `about:blank`)
  - Nollställs INTE vid bakåtnavigering → cookie-samtycke bevaras inom sessionen
- **Bokningsinfo-modal** (`#guide-overlay`): bottom sheet, visas automatiskt när iframen öppnas
  - 5 numrerade steg med reg, station, datum och tid förifyllda
  - Stängs med ✕, "Fortsätt"-knapp, eller klick på bakgrund
  - Öppnas igen via "Bokningsinfo"-knappen i topbaren

---

## Bokningsflöde (v1.1)

```
Sökning (Playwright headless) → Resultat → Bekräfta → iframe med carspect.se
```

Användaren slutför hela bokningen manuellt i iframen. Ingen Playwright-automation i bokningsdelen.

---

## Viktiga tekniska begränsningar (same-origin policy)

carspect.se laddas i en cross-origin iframe. Det innebär:
- **Kan INTE** auto-klicka cookie-bannern i iframen (DOM otillgänglig)
- **Kan INTE** detektera vilket steg användaren är på i carspect.se flödet
- **Kan INTE** läsa/skriva cookies för carspect.se-domänen
- Cookie-samtycket lever i sessionStorage/cookies på carspect.se-origin, bevaras om iframen hålls laddad

**carspect.se sätter INGA `X-Frame-Options` eller CSP-headers** → iframe fungerar utan problem.

---

## Tech stack
- **Runtime:** Node.js med ESM (`"type": "module"`)
- **Browser automation:** Playwright (Chromium) — endast för scraping
- **Server:** Express + CORS (port 3000)
- **Frontend:** Vanilla HTML/CSS/JS, inga externa ramverk
- **Fonts:** Barlow + Barlow Condensed (Google Fonts)
- **Språk på sidan:** Svenska (carspect.se är en svensk tjänst)

---

## Kända detaljer & quirks (scraper)

- carspect.se cookie-banner: `button.cky-btn-accept` — dismissas i Playwright
- Location-prompt: `text=Tillåt vid besök` — dismissas
- "Fortsätt"-knappen kan vara trög: 3 retry-försök inbyggt i `clickFortsatt()`
- Tidsluckor: `.slot-option-container`, datumhuvud: `.header-text`
- Geolocation: Stockholm (59.3293, 18.0686)
- Stationssökfält: `input[placeholder*="närheten"]` eller liknande

---

## Git & versioner

- **v1.0** – Grundläggande scraper + Playwright-bokning + frontend (mars 2026)
- **v1.02** – Optimerad scraper (single browser, resource blocking), area-filter, bokningsflöde via macOS `open`
- **v1.1** – iframe-bokning, Bokningsinfo-guide modal, Senaste sökning-banner, Bokningsinfo-pill i topbar (mars 2026)

GitHub: https://github.com/nano1980/besiktningsapp

---

## Starta projektet

```bash
cd ~/carspect-agent
npm install                      # första gången
npx playwright install chromium  # första gången
npm start                        # startar Express-servern på port 3000
```

Öppna sedan `file:///Users/hernangil/carspect-agent/index.html` i webbläsaren.

---

## Potentiella nästa steg (ej implementerat)

- **Kartvy** (Leaflet.js + OpenStreetMap) — visa stationer på karta i resultatlistan
- **Ta bort `bookTimeslot()`** från scraper.js (oanvänd kod)
- **Ta bort diagnostic logger** från scrapeBatch (JSON-response interceptor, finns kvar för felsökning)
- **XHR-interception** — om carspect.se API:t identifieras kan scraping göras via direkta fetch-anrop istället för DOM-scraping

---

*Senast uppdaterad: Mars 2026 — v1.1*
