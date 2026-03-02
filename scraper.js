import { chromium } from "playwright";
import fs from "fs";

const BASE_URL = "https://www.carspect.se/boka-tid";
const RESULTS_DIR = "./results";

// ── Helpers ────────────────────────────────────────────────────────────────

async function dismissCookie(page) {
  try { await page.waitForSelector("button.cky-btn-accept", { timeout: 1500 }); await page.click("button.cky-btn-accept"); } catch {}
}

async function dismissLocation(page) {
  try { await page.waitForSelector('text=Tillåt vid besök', { timeout: 1000 }); await page.click('text=Tillåt vid besök'); } catch {}
}

async function clickFortsatt(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const btn = await page.waitForSelector('button:has-text("Fortsätt")', { timeout: 3000 });
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      return;
    } catch { if (attempt < 3) await page.waitForTimeout(300); }
  }
}

async function enterReg(page, reg) {
  const regInput = await page.waitForSelector("input.plate-input-booking", { timeout: 20000 });
  await regInput.fill(reg);
  await page.click("button.plate-load-button");
  await page.waitForSelector('.booking-component-body', { timeout: 12000 }).catch(() => {});
  await page.waitForSelector('button:has-text("Fortsätt")', { timeout: 5000 }).catch(() => {});
}

function newContext(browser) {
  return browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "sv-SE",
    viewport: { width: 1280, height: 900 },
    permissions: ["geolocation"],
    geolocation: { latitude: 59.3293, longitude: 18.0686 },
  });
}

// ── Scrape ─────────────────────────────────────────────────────────────────

export async function scrapeTimeslots({ reg, location }) {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR);
  console.log(`\n🚗 Scraping ${location} for ${reg}...`);

  const browser = await chromium.launch({ headless: true });
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, i) => scrapeBatch(browser, reg, location, i))
  );

  const seen = new Set();
  const merged = [];
  for (const batch of results) {
    for (const slot of batch) {
      const key = `${slot.date}_${slot.time}_${slot.station}`;
      if (!seen.has(key)) { seen.add(key); merged.push(slot); }
    }
  }
  await browser.close();
  merged.sort((a, b) => new Date(`${a.date}T${a.time||"00:00"}`) - new Date(`${b.date}T${b.time||"00:00"}`));
  console.log(`✅ ${merged.length} timeslots found`);
  return { timeslots: merged, inspectionType: "Kontrollbesiktning", stations: [] };
}

async function scrapeBatch(browser, reg, location, batchIndex) {
  const offset = batchIndex * 5;
  const label = `B${batchIndex + 1}`;
  const context = await newContext(browser);
  await context.grantPermissions(["geolocation"], { origin: "https://www.carspect.se" });
  const page = await context.newPage();

  // DIAGNOSTIC: log all JSON API responses to find the timeslot endpoint
  page.on("response", async response => {
    const ct = response.headers()["content-type"] ?? "";
    if (!ct.includes("application/json")) return;
    const url = response.url();
    if (url.includes("carspect")) {
      try {
        const json = await response.json();
        console.log(`  [${label}] API → ${url.replace("https://www.carspect.se", "")}`);
        console.log(`  [${label}]      `, JSON.stringify(json).slice(0, 200));
      } catch {}
    }
  });

  // Block everything not needed for scraping
  await page.route("**/*", route => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    if (["image", "media", "font", "stylesheet"].includes(type)) return route.abort();
    if (["google-analytics", "googletagmanager", "facebook", "hotjar", "clarity", "cookiebot", "cookie-script"].some(s => url.includes(s))) return route.abort();
    route.continue();
  });

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 25000 });
    await dismissCookie(page);
    await enterReg(page, reg);

    // Service → Fortsätt (enterReg already waits for the button)
    await clickFortsatt(page);
    await page.waitForSelector('.form-check-container, input[type="checkbox"]', { timeout: 6000 }).catch(() => {});

    // Stations
    await dismissLocation(page);
    try {
      const box = await page.waitForSelector('input[placeholder*="närheten"], input[placeholder*="ort"], input[placeholder*="station"]', { timeout: 4000 });
      await box.fill(location);
      await page.waitForTimeout(500);
    } catch {}

    const clicked = await page.evaluate((offset) => {
      const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      cbs.forEach(cb => { if (cb.checked) (cb.closest('.form-check-container') ?? cb.parentElement)?.click(); });
      const batch = cbs.slice(offset, offset + 5);
      batch.forEach(cb => (cb.closest('.form-check-container') ?? cb.parentElement)?.click());
      return batch.length;
    }, offset);

    if (clicked === 0) return [];

    await clickFortsatt(page);
    await page.waitForSelector('.react-datepicker', { timeout: 8000 }).catch(() => {});

    // Nästa lediga tid
    try {
      const btn = await page.waitForSelector('button:has-text("Nästa lediga tid")', { timeout: 6000 });
      await btn.click();
      await page.waitForSelector('.slot-option-container', { timeout: 8000 }).catch(() => {});
    } catch {}

    const timeslots = await page.evaluate(() => {
      let date = "";
      document.querySelectorAll('.header-text').forEach(el => {
        const m = el.textContent?.trim().match(/(\d{4}-\d{2}-\d{2})/);
        if (m) date = m[1];
      });
      return Array.from(document.querySelectorAll('.slot-option-container')).map(slot => ({
        date,
        time:    slot.querySelector('.slot-time')?.textContent?.trim() ?? "",
        station: slot.querySelector('.slot-station')?.textContent?.trim() ?? "",
        price:   slot.querySelector('.slot-price')?.textContent?.trim() ?? "",
        address: "", available: true,
      })).filter(s => s.date && s.time);
    });

    console.log(`  [${label}] ✅ ${timeslots.length} slots`);
    return timeslots;
  } catch (e) {
    console.error(`  [${label}] ❌ ${e.message}`);
    return [];
  } finally {
    await context.close();
  }
}

// ── Book ───────────────────────────────────────────────────────────────────

export async function bookTimeslot({ reg, station, date, time }) {
  console.log(`\n📅 Booking: ${time} ${date} @ ${station} for ${reg}`);

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=430,900"],
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    locale: "sv-SE",
    viewport: { width: 430, height: 900 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    permissions: ["geolocation"],
    geolocation: { latitude: 59.3293, longitude: 18.0686 },
  });
  await context.grantPermissions(["geolocation"], { origin: "https://www.carspect.se" });
  const page = await context.newPage();

  // Minimize immediately so the user doesn't see the navigation
  let cdp, windowId;
  try {
    cdp = await context.newCDPSession(page);
    ({ windowId } = await cdp.send("Browser.getWindowForTarget", {}));
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  } catch (e) {
    console.warn("  ⚠ Could not minimize window:", e.message);
  }

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 25000 });
    await dismissCookie(page);

    // Reg
    await enterReg(page, reg);
    console.log("  ✓ Reg");

    // Service
    await clickFortsatt(page);
    await page.waitForTimeout(800);
    console.log("  ✓ Service");

    // Stations
    await dismissLocation(page);
    try {
      const box = await page.waitForSelector('input[placeholder*="närheten"], input[placeholder*="ort"], input[placeholder*="station"]', { timeout: 4000 });
      await box.fill(station.split(" ").slice(0, 2).join(" "));
      await page.waitForTimeout(1000);
    } catch {}

    // Click station card
    const stationResult = await page.evaluate((target) => {
      const containers = Array.from(document.querySelectorAll('.form-check-container'));
      const match = containers.find(c => c.textContent?.toLowerCase().includes(target.toLowerCase())) ?? containers[0];
      if (!match) return false;
      match.click();
      const cb = match.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      return match.textContent?.trim().substring(0, 50);
    }, station);

    console.log(`  ✓ Station: ${stationResult}`);
    await page.waitForTimeout(600);

    // Retry with mouse events if Fortsätt still disabled
    const enabled = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Fortsätt'));
      return btn && !btn.disabled;
    });
    if (!enabled) {
      await page.evaluate((target) => {
        const containers = Array.from(document.querySelectorAll('.form-check-container'));
        const match = containers.find(c => c.textContent?.toLowerCase().includes(target.toLowerCase())) ?? containers[0];
        if (match) ['mousedown','mouseup','click'].forEach(e =>
          match.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true }))
        );
      }, station);
      await page.waitForTimeout(500);
    }

    await clickFortsatt(page);
    await page.waitForSelector('.react-datepicker', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    console.log("  ✓ Date/time page");

    // Nästa lediga tid
    try {
      const btn = await page.waitForSelector('button:has-text("Nästa lediga tid")', { timeout: 4000 });
      await btn.click();
      await page.waitForTimeout(1200);
    } catch {}

    // Click date
    await page.evaluate((targetDate) => {
      const days = Array.from(document.querySelectorAll('.react-datepicker__day:not(.react-datepicker__day--disabled)'));
      for (const day of days) {
        if ((day.getAttribute('aria-label') ?? "").includes(targetDate)) { day.click(); return; }
      }
      const dayNum = parseInt(targetDate.split("-")[2], 10);
      for (const day of days) {
        const txt = day.querySelector('.date-text')?.textContent?.trim();
        if (parseInt(txt) === dayNum && !day.classList.contains('react-datepicker__day--outside-month')) {
          day.click(); return;
        }
      }
    }, date);

    await page.waitForTimeout(800);
    console.log("  ✓ Date clicked");

    // Click timeslot
    await page.evaluate((targetTime) => {
      for (const slot of document.querySelectorAll('.slot-option-container')) {
        if (slot.querySelector('.slot-time')?.textContent?.trim() === targetTime) {
          slot.click(); return;
        }
      }
    }, time);

    await page.waitForTimeout(500);
    console.log("  ✓ Slot clicked");

    // Navigate to payment page
    await clickFortsatt(page);
    console.log("  ✓ On payment page — waiting for user to complete");

    // Detect payment page loaded (step 4 active in stepper)
    await page.waitForSelector('.step-active, [class*="step"][class*="active"], .booking-step-4', { timeout: 8000 }).catch(() => {});

    // Restore the minimized window now that we're on the payment page
    if (cdp && windowId != null) {
      try {
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left: 100, top: 50, width: 430, height: 900, windowState: "normal" },
        });
        await cdp.detach();
      } catch (e) {
        console.warn("  ⚠ Could not restore window:", e.message);
      }
    }

    // Return immediately — browser stays open for user to complete payment
    // Server signals frontend that the window is open and ready
    return {
      booked: true,
      reg, station, date, time,
      status: "payment_window_open",
      message: "Betalningsfönstret är öppet — slutför betalningen där",
    };

  } finally {
    // Do NOT close browser here — user needs it to complete payment
    // Browser will close naturally when user is done
  }
}
