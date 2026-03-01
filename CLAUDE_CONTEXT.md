# Carspect Agent – Projektkontext för Claude

> Läs den här filen i början av varje session så att du snabbt förstår projektet utan att användaren behöver förklara om.

---

## Vad är det här?

**carspect-agent** är ett Node.js-verktyg som automatiserar sökning och bokning av besiktningstider på [carspect.se](https://www.carspect.se/boka-tid) med hjälp av **Playwright** (headless browser automation).

Projektet finns lokalt på användarens Mac under:
```
~/carspect-agent/
```

---

## Filstruktur

```
carspect-agent/
├── cli.js          – CLI-verktyg för att köra scraper från terminalen
├── scraper.js      – Kärnan: Playwright-automation för scraping & bokning
├── server.js       – Express REST API (port 3000)
├── index.html      – Frontend-UI som pratar med servern
├── package.json    – ESM-projekt, dependencies: playwright, express, cors
└── results/        – Sparade JSON/CSV-resultat från körningar
```

---

## Hur det fungerar

### scraper.js
Exporterar två funktioner:

**`scrapeTimeslots({ reg, location })`**
- Kör 3 parallella Playwright-batchar (5 stationer per batch = 15 stationer totalt)
- Deduplicerar och sorterar resultaten efter datum/tid
- Returnerar `{ timeslots: [...], inspectionType, stations }`

**`bookTimeslot({ reg, station, date, time })`**
- Navigerar hela bokningsflödet på carspect.se headless
- Lyssnar på **två scenarion** för att fånga Klarna-URL:en:
  1. Sidan navigerar bort från `carspect.se` → `page.waitForURL()`
  2. Klarna öppnas som popup/ny tab → `context.waitForEvent("page")`
- Returnerar `{ booked, url, cookies }` – Klarna-URL skickas till frontend som gör `window.location.href = url`

### server.js – Express API på port 3000
```
GET  /timeslots?reg=ABC123&location=Stockholm   → Returnerar lediga tider (JSON + sparar CSV)
POST /book  { reg, station, date, time }         → Startar bokning, returnerar Klarna payment-URL
GET  /health                                     → { status: "ok" }
```

### index.html – Frontend
- Mobilanpassad app-layout (max-width 600px), körs som `file:///Users/hernangil/carspect-agent/index.html`
- 3 skärmar: Sök → Resultat → Bekräfta
- Vid bokning: visar loader och gör `window.location.href = d.url` för att skicka användaren till Klarna **i samma fönster**
- Kommunicerar med Express-servern på `http://localhost:3000`

### cli.js – Kommandoradsverktyg
```bash
node cli.js --reg ABC123 --location Stockholm
node cli.js --reg ABC123 --location Stockholm --type Kontrollbesiktning
```

---

## Tech stack
- **Runtime:** Node.js med ESM (`"type": "module"`)
- **Browser automation:** Playwright (Chromium)
- **Server:** Express + CORS
- **Språk på sidan:** Svenska (carspect.se är en svensk tjänst)

---

## Kända detaljer & quirks

- Sidan har cookie-banner som dismissas via `button.cky-btn-accept`
- Sidan kan fråga om plats-tillstånd (`Tillåt vid besök`) – dismissas
- Navigering sker via en "Fortsätt"-knapp som kan vara trög – retries finns inbyggt
- Tidsluckor hämtas via `.slot-option-container` och datumhuvud via `.header-text`
- Geolocation sätts till Stockholm (59.3293, 18.0686) som default

### ⚠️ Känt problem: Klarna-redirect (åtgärdat mars 2026)
**Problem:** `bookTimeslot` returnerade alltid `https://www.carspect.se/boka-tid` som payment-URL istället för Klarna-URL:en. Detta berodde på att `page.url()` hämtades direkt efter `clickFortsatt()` innan Klarna-redirecten hann ske. Dessutom öppnar carspect.se Klarna som en **popup/ny tab** snarare än att navigera i samma fönster.

**Lösning:** Koden lyssnar nu parallellt på `page.waitForURL()` och `context.waitForEvent("page")` för att fånga Klarna-URL:en oavsett hur sidan väljer att öppna den.

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

*Senast uppdaterad: Mars 2026*
