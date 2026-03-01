# Carspect Agent – Projektkontext för Claude

> Läs den här filen i början av varje session så att du snabbt förstår projektet utan att användaren behöver förklara om.

---

## Vad är det här?

**carspect-agent** är ett Node.js-verktyg som automatiserar sökning och bokning av besiktningstider på [carspect.se](https://www.carspect.se/boka-tid) med hjälp av **Playwright** (headless browser automation).

Projektet finns lokalt på användarens Mac under:
```
~/carspect-agent/
```

GitHub: https://github.com/nano1980/besiktningsapp

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
- Kör **headless: true**

**`bookTimeslot({ reg, station, date, time })`**
- Öppnar ett **synligt mobilanpassat Playwright-fönster** (430×900, isMobile: true)
- Navigerar hela bokningsflödet automatiskt
- Stannar kvar på carspects **betalningssida** – användaren slutför betalningen där
- Returnerar `{ booked: true, status: "payment_window_open", message }`
- Stänger INTE browsern – användaren gör det själv efter betalning

### server.js – Express API på port 3000
```
GET  /timeslots?reg=ABC123&location=Stockholm   → Returnerar lediga tider (JSON + sparar CSV)
POST /book  { reg, station, date, time }         → Öppnar betalningsfönster, returnerar status
GET  /health                                     → { status: "ok" }
```

### index.html – Frontend
- Mobilanpassad app-layout (max-width 600px)
- Körs som `file:///Users/hernangil/carspect-agent/index.html`
- 4 skärmar: Sök → Resultat → Bekräfta → Betalning pågår
- Vid bokning: visar loader → när API svarar visas "screen-payment" med bokningsdetaljer
- Användaren slutför betalningen i Playwright-fönstret som öppnats
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

### ⚠️ Betalningssidan (löst mars 2026)
**Problem:** Carspect.se har sin **egen** betalningssida (inte Klarna-redirect). URL:en förblir `https://www.carspect.se/boka-tid` genom hela flödet. Sessions är knutna till browser-instansen och kan inte överföras till användarens webbläsare via cookies.

**Lösning (Alternativ A):** Playwright-fönstret hålls öppet och synligt på betalningssidan. Användaren slutför betalningen direkt i Playwright-fönstret. Frontend visar en "Slutför betalningen"-skärm med bokningsdetaljer medans fönstret är öppet.

**Betalningsfönstret** körs i mobilläge (430×900, isMobile: true, touch) för att matcha appens känsla.

---

## Git & versioner
- **v1.0** – Grundläggande scraper + bokning + frontend (pushad mars 2026)
- GitHub: https://github.com/nano1980/besiktningsapp

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
