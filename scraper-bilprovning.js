// scraper-bilprovning.js — Opus Bilprovning scraper
// Hybrid: Playwright navigates vehicle confirmation to establish auth session,
// then Node.js fetch calls stations/availableTimes APIs in parallel.

import { chromium } from "playwright";

const BASE  = "https://boka.bilprovning.se";
const API   = "https://api2.bilprovning.se";
const HDRS  = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Referer": BASE + "/",
  "Origin":  BASE,
};

const MAX_PER_STATION = 5;
const DAYS_AHEAD      = 31;
const MAX_STATIONS    = 15;

function kmBetween(lat1, lon1, lat2, lon2) {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r, dLon = (lon2 - lon1) * d2r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*d2r) * Math.cos(lat2*d2r) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export async function scrapeBilprovning({ reg, location }, onProgress) {
  const step = msg => { console.log(`  [OP] ${msg}`); onProgress?.(msg); };
  console.log(`\n🔵 Bilprovningen: scraping ${location} for ${reg}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "sv-SE",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  // Block images/media/trackers to speed up
  await page.route("**/*", route => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    if (["image", "media", "font"].includes(type)) return route.abort();
    if (["google-analytics", "googletagmanager", "facebook", "hotjar", "cookiebot"].some(s => url.includes(s))) return route.abort();
    route.continue();
  });

  // Extract bookingId from any API response URL pattern
  let bid = null;
  page.on("response", res => {
    const m = res.url().match(/\/api\/bookings\/(B\w+)\//);
    if (m && !bid) { bid = m[1]; console.log(`  [OP] bookingId: ${bid}`); }
  });

  try {
    await page.goto(`${BASE}/vehiclesandproducts`, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Dismiss cookie banner
    await page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', { timeout: 3000 }).catch(() => {});

    // Enter reg number and submit
    await page.fill('input[name="regNo"]', reg.toUpperCase());
    await page.click('button:has-text("Hämta fordonsuppgifter")');
    step("Söker fordon...");

    // Wait for vehicle info → confirm (vehicle is associated with booking at this point)
    await page.waitForSelector('button:has-text("Fortsätt")', { timeout: 15000 });
    await page.click('button:has-text("Fortsätt")');
    step("Bekräftar fordon...");

    // Give the booking API a moment to register the vehicle association
    await page.waitForTimeout(800);

    if (!bid) {
      console.log(`  [OP] ❌ no bookingId captured`);
      return { timeslots: [], source: "Bilprovningen" };
    }

    // Extract cookies for Node.js fetch
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const headers = { ...HDRS, Cookie: cookieHeader };

    await context.close();
    await browser.close();

    // Resolve location to coordinates
    const coordRes = await fetch(`${API}/api/stations/coordinate?search=${encodeURIComponent(location)}`, { headers });
    const coords   = coordRes.ok ? await coordRes.json() : null;
    if (!coords?.Latitude) {
      console.log(`  [OP] ❌ no coords for ${location}`);
      return { timeslots: [], source: "Bilprovningen" };
    }

    // Get all stations, sort by distance, take closest MAX_STATIONS
    step("Hämtar stationer...");
    const stRes = await fetch(`${API}/api/bookings/${bid}/stations?lat=${coords.Latitude}&lon=${coords.Longitude}&radius=100000000`, { headers });
    if (!stRes.ok) {
      console.log(`  [OP] ❌ stations fetch failed: ${stRes.status}`);
      return { timeslots: [], source: "Bilprovningen" };
    }
    const allStations = await stRes.json();
    if (!Array.isArray(allStations) || !allStations.length) {
      console.log(`  [OP] ❌ no stations returned`);
      return { timeslots: [], source: "Bilprovningen" };
    }

    const stations = allStations
      .filter(s => s.Latitude && s.Longitude)
      .map(s => ({ ...s, _km: kmBetween(coords.Latitude, coords.Longitude, s.Latitude, s.Longitude) }))
      .sort((a, b) => a._km - b._km)
      .slice(0, MAX_STATIONS);
    console.log(`  [OP] ${allStations.length} stations, using ${stations.length} closest (nearest: ${stations[0]?.Name} ${stations[0]?._km?.toFixed(0)}km)`);

    // Get available times for all closest stations in parallel
    step("Hämtar tider via API...");
    const today = new Date().toISOString().split("T")[0];
    const end   = new Date(Date.now() + DAYS_AHEAD * 86400000).toISOString().split("T")[0];

    const allTimes = (await Promise.all(
      stations.map(s =>
        fetch(`${API}/api/bookings/${bid}/availableTimes?stationIds=${s.Id}&start=${today}&end=${end}`, { headers })
          .then(r => r.ok ? r.json() : []).catch(() => [])
      )
    )).flat();

    if (!allTimes.length) {
      console.log(`  [OP] ⚠ no timeslots`);
      return { timeslots: [], source: "Bilprovningen" };
    }
    console.log(`  [OP] ${stations.length} stations, ${allTimes.length} raw time slots`);

    // Parse and deduplicate
    allTimes.sort((a, b) => new Date(a.Time) - new Date(b.Time));
    const seen = new Set(), perStation = {}, timeslots = [];
    for (const t of allTimes) {
      if (!t.Time) continue;
      const [date, timeFull] = t.Time.split("T");
      const time = timeFull.slice(0, 5);
      const key  = `${date}_${time}_${t.Station}`;
      if (seen.has(key)) continue;
      seen.add(key);
      perStation[t.Station] = (perStation[t.Station] ?? 0) + 1;
      if (perStation[t.Station] > MAX_PER_STATION) continue;
      timeslots.push({
        date, time,
        station:   t.Station,
        price:     `${t.Price} kr`,
        address:   "",
        source:    "Bilprovningen",
        available: true,
      });
    }

    console.log(`  [OP] ✅ ${timeslots.length} timeslots`);
    return { timeslots, source: "Bilprovningen" };

  } catch (e) {
    console.error(`  [OP] ❌ ${e.message}`);
    return { timeslots: [], source: "Bilprovningen" };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
