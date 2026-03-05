// Bilprovningen AB scraper — hybrid approach
// Navigate full flow to /asb/sv/boka/tider to establish session,
// then call the REST API for ALL stations in parallel.

import { chromium } from "playwright";

const BASE     = "https://boka.bilprovningen.se";
const BOOK_URL = `${BASE}/asb/sv/boka`;
const PRODUCT  = "770d69b7-fefb-e511-80cc-000d3a22a090";

const MAX_PER_STATION = 5; // earliest slots to keep per station

function newContext(browser) {
  return browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "sv-SE",
    viewport: { width: 1280, height: 900 },
  });
}

export async function scrapeBilprovningen({ reg, location }, onProgress) {
  const step = (msg) => { console.log(`  [BP] ${msg}`); onProgress?.(msg); };
  console.log(`\n🔷 Bilprovningen AB: scraping ${location} for ${reg}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await newContext(browser);
  const page    = await context.newPage();

  await page.route("**/*", route => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    if (["image", "media", "font"].includes(type)) return route.abort();
    if (["google-analytics", "googletagmanager", "facebook", "hotjar",
         "engage", "clarity", "cookiebot"].some(s => url.includes(s))) return route.abort();
    route.continue();
  });

  // Capture vehicleId from vehicle API response
  let vehicleId = null;
  page.on("response", async res => {
    if (!res.url().includes("/api/v1/booking/vehicle")) return;
    try {
      const j = await res.json();
      if (j?.vehicleId) { vehicleId = j.vehicleId; console.log(`  [BP] vehicleId: ${vehicleId}`); }
    } catch {}
  });

  try {
    await page.goto(BOOK_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Fill reg immediately when input appears, then dismiss cookie banner if present
    const regInput = await page.waitForSelector('#licenseNumber', { timeout: 10000 });
    await regInput.fill(reg.toUpperCase());
    await page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', { timeout: 500 }).catch(() => {});
    await page.click('button[type="submit"]');
    step("Söker fordon...");

    // Step 2: Confirm vehicle
    await page.waitForSelector('button:has-text("Ja, fortsätt")', { timeout: 15000 });
    await page.click('button:has-text("Ja, fortsätt")');
    step("Bekräftar fordon...");

    // Step 3: Select service → Gå vidare
    await page.waitForSelector('label:has(input[role="radio"])', { timeout: 10000 });
    await page.click('label:has(input[role="radio"])');
    await page.waitForSelector('button:has-text("Gå vidare")', { timeout: 5000 });
    await page.click('button:has-text("Gå vidare")');
    step("Väljer tjänst...");

    // Step 4: Dismiss modal
    await page.click('button:has-text("Nej tack")', { timeout: 8000 }).catch(() => {});

    // Step 5: Search for location
    const qInput = await page.waitForSelector('#query', { timeout: 10000 });
    await qInput.fill(location);
    await page.click('button[type="submit"]');
    await page.waitForSelector('#stations li label', { timeout: 10000 });
    const beforeCount = (await page.$$('#stations li label')).length;
    const visaFlerClicked = await page.click('button:has-text("Visa fler")', { timeout: 5000 })
      .then(() => true).catch(() => false);
    if (visaFlerClicked) {
      await page.waitForFunction(
        (prev) => document.querySelectorAll('#stations li label').length > prev,
        beforeCount,
        { timeout: 3000 }
      ).catch(() => {});
    }
    step("Söker stationer...");

    // Step 6: Select first 5 stations → Gå vidare → reach /asb/sv/boka/tider
    // (establishes the session state needed for the timeslot API to return 200)
    const labels = await page.$$('#stations li label');
    for (let i = 0; i < Math.min(5, labels.length); i++) {
      await labels[i].click();
    }
    await page.click('button:has-text("Gå vidare")');
    // Wait for URL to reach /tider (fires as soon as navigation starts, before DOM renders)
    // Fall back to timeslot selector in case URL pattern differs
    await Promise.race([
      page.waitForURL(/\/tider/, { timeout: 30000 }),
      page.waitForSelector('li:has(input[name="timeslot"])', { timeout: 30000 }),
    ]);
    step("Hämtar tider via API...");

    if (!vehicleId) {
      console.log("  [BP] ⚠ No vehicleId — aborting");
      return { timeslots: [], source: "Bilprovningen AB" };
    }

    // Extract session cookies from browser, then fetch from Node.js (bypasses browser connection limits)
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const headers = { Cookie: cookieHeader, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" };

    // Close browser early — we have everything we need
    await context.close();
    await browser.close();

    const today   = new Date().toISOString().split("T")[0];
    const endDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const stRes = await fetch(`${BASE}/api/v1/booking/stations?location=${encodeURIComponent(location)}&products=${PRODUCT}&orderBy=&lastInspectionStation=`, { headers });
    if (!stRes.ok) return { timeslots: [], source: "Bilprovningen AB" };
    const stations = await stRes.json();
    if (!Array.isArray(stations) || !stations.length) return { timeslots: [], source: "Bilprovningen AB" };

    const allTimes = (await Promise.all(
      stations.map(s =>
        fetch(`${BASE}/api/v1/booking/timeSlots/station?stationId=${s.id}&productIdsA=${PRODUCT}&vehicleIdA=${vehicleId}&dateFrom=${today}T00:00:00&dateTo=${endDate}T23:59:59&isExistingBooking=false`, { headers })
          .then(r => r.ok ? r.json() : []).catch(() => [])
      )
    )).flat();

    if (!allTimes.length) {
      console.log("  [BP] ⚠ API returned no data");
      return { timeslots: [], source: "Bilprovningen AB" };
    }

    const stationMap = Object.fromEntries(stations.map(s => [s.id, s]));
    console.log(`  [BP] ${stations.length} stations, ${allTimes.length} raw slots`);

    // Sort by date/time, keep first MAX_PER_STATION per station
    allTimes.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const seen = new Set(), perStation = {}, timeslots = [];
    for (const t of allTimes) {
      if (!t.timestamp) continue;
      const [date, timeFull] = t.timestamp.split("T");
      const time    = timeFull.slice(0, 5);
      const stName  = stationMap[t.stationId]?.name ?? t.stationId;
      const key     = `${date}_${time}_${stName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      perStation[stName] = (perStation[stName] ?? 0) + 1;
      if (perStation[stName] > MAX_PER_STATION) continue;
      timeslots.push({
        date,
        time,
        station:   stName,
        price:     `${t.totalPriceInclVAT} kr`,
        address:   stationMap[t.stationId]?.postStreet ?? "",
        source:    "Bilprovningen AB",
        available: true,
      });
    }

    console.log(`  [BP] ✅ ${timeslots.length} timeslots (${stations.length} stations)`);
    return { timeslots, source: "Bilprovningen AB" };

  } catch (e) {
    console.error(`  [BP] ❌ ${e.message}`);
    return { timeslots: [], source: "Bilprovningen AB" };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
