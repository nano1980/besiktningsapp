import { chromium } from "playwright";
import fs from "fs";

const BASE_URL = "https://www.carspect.se/boka-tid";
const RESULTS_DIR = "./results";

// ── Helpers ────────────────────────────────────────────────────────────────

async function dismissCookie(page) {
  try { await page.waitForSelector("button.cky-btn-accept", { timeout: 3000 }); await page.click("button.cky-btn-accept"); } catch {}
}

async function dismissLocation(page) {
  try { await page.waitForSelector('text=Tillåt vid besök', { timeout: 2000 }); await page.click('text=Tillåt vid besök'); } catch {}
}

async function clickFortsatt(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const btn = await page.waitForSelector('button:has-text("Fortsätt")', { timeout: 4000 });
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      return;
    } catch { await page.waitForTimeout(500); }
  }
}

async function enterReg(page, reg) {
  const regInput = await page.waitForSelector("input.plate-input-booking", { timeout: 20000 });
  await regInput.fill(reg);
  await page.click("button.plate-load-button");
  await page.waitForSelector('.booking-component-body', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);
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

  const results = await Promise.all(
    Array.from({ length: 3 }, (_, i) => scrapeBatch(reg, location, i))
  );

  const seen = new Set();
  const merged = [];
  for (const batch of results) {
    for (const slot of batch) {
      const key = `${slot.date}_${slot.time}_${slot.station}`;
      if (!seen.has(key)) { seen.add(key); merged.push(slot); }
    }
  }
  merged.sort((a, b) => new Date(`${a.date}T${a.time||"00:00"}`) - new Date(`${b.date}T${b.time||"00:00"}`));
  console.log(`✅ ${merged.length} timeslots found`);
  return { timeslots: merged, inspectionType: "Kontrollbesiktning", stations: [] };
}

async function scrapeBatch(reg, location, batchIndex) {
  const offset = batchIndex * 5;
  const label = `B${batchIndex + 1}`;
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await newContext(browser);
  await context.grantPermissions(["geolocation"], { origin: "https://www.carspect.se" });
  const page = await context.newPage();

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 25000 });
    await dismissCookie(page);
    await enterReg(page, reg);

    // Service → Fortsätt
    await clickFortsatt(page);
    await page.waitForTimeout(900);

    // Stations
    await dismissLocation(page);
    try {
      const box = await page.waitForSelector('input[placeholder*="närheten"], input[placeholder*="ort"], input[placeholder*="station"]', { timeout: 4000 });
      await box.fill(location);
      await page.waitForTimeout(800);
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
    await page.waitForTimeout(400);

    // Nästa lediga tid
    try {
      const btn = await page.waitForSelector('button:has-text("Nästa lediga tid")', { timeout: 6000 });
      await btn.click();
      await page.waitForSelector('.slot-option-container', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
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
    await browser.close();
  }
}

// ── Book ───────────────────────────────────────────────────────────────────

export async function bookTimeslot({ reg, station, date, time }) {
  console.log(`\n📅 Booking headless: ${time} ${date} @ ${station} for ${reg}`);

  // DEBUG: headless: false so we can see what happens after slot click
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await newContext(browser);
  await context.grantPermissions(["geolocation"], { origin: "https://www.carspect.se" });
  const page = await context.newPage();

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

    // DEBUG: screenshot + log buttons before final click
    await page.screenshot({ path: "./results/debug_before_payment.png", fullPage: true });
    console.log("  📸 Screenshot saved: results/debug_before_payment.png");
    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).map(b => ({
        text: b.textContent?.trim().substring(0, 50),
        disabled: b.disabled,
        visible: b.offsetParent !== null,
      }))
    );
    console.log("  🔘 Buttons:", JSON.stringify(buttons));

    // Listen for popup (new tab) OR navigation away from carspect.se
    const popupPromise = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);

    await clickFortsatt(page);
    console.log("  ✓ clickFortsatt done, URL:", page.url());

    let klarnaUrl = null;

    // Case 1: current page navigates away from carspect to Klarna
    try {
      await page.waitForURL(url => !url.includes("carspect.se"), { timeout: 10000 });
      klarnaUrl = page.url();
      console.log(`  ✓ Page navigated to: ${klarnaUrl}`);
    } catch {
      // Case 2: Klarna opened as popup/new tab
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        klarnaUrl = popup.url();
        console.log(`  ✓ Popup URL: ${klarnaUrl}`);
        await popup.close();
      }
    }

    // DEBUG: screenshot after click regardless
    await page.screenshot({ path: "./results/debug_after_payment.png", fullPage: true });
    console.log("  📸 Screenshot saved: results/debug_after_payment.png");
    console.log("  Final URL:", page.url());

    if (!klarnaUrl || klarnaUrl.includes("carspect.se")) {
      throw new Error("Kunde inte nå betalningssidan – fick: " + (klarnaUrl ?? "ingen URL"));
    }

    console.log(`  ✓ Payment URL: ${klarnaUrl}`);
    const cookies = await context.cookies();

    return {
      booked: true,
      reg, station, date, time,
      url: klarnaUrl,
      cookies,
    };

  } finally {
    await browser.close();
  }
}
