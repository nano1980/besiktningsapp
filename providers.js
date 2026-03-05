/**
 * Provider Registry
 * =================
 * All scraping providers are declared here. The server and frontend
 * read this list to run scrapers, build loader rows, and route bookings.
 *
 * Adding a provider
 * -----------------
 *  1. Create scraper-<name>.js exporting an async function with the signature:
 *       async function scrape<Name>({ reg, location })
 *         => { timeslots: Slot[], source: string }
 *     where Slot = { date, time, station, price, source, available }
 *
 *  2. Import it below and add an entry to PROVIDERS with:
 *       id          – unique kebab-case key (CSS classes, loader row ID, sources map key)
 *       source      – string written on every returned timeslot (must be unique)
 *       displayName – label shown in badges and the loader overlay
 *       color       – hex brand colour (loader dot + badge tint)
 *       bookingUrl  – URL to open when the user proceeds to book
 *       scrape      – async ({ reg, location }) => { timeslots }
 *
 *  3. In index.html add:
 *       a. CSS: .loader-source-dot.<id>  { background: <color> }
 *              .source-badge.<id>         (badge background/text/border)
 *              .confirm-service-badge.<id>
 *       b. HTML: a <div class="loader-source-row" id="loader-row-<id>"> block
 *       c. JS: add the provider to the frontend PROVIDERS array (one line)
 *
 * Removing a provider
 * -------------------
 *  1. Delete the entry from PROVIDERS below.
 *  2. Remove the CSS, loader HTML row, and JS PROVIDERS entry from index.html.
 *  3. Delete (or keep) the scraper-<name>.js file.
 */

import { scrapeTimeslots }    from "./scraper.js";
import { scrapeBilprovning }  from "./scraper-bilprovning.js";
import { scrapeBilprovningen } from "./scraper-bilprovningen.js";

export const PROVIDERS = [
  {
    id:          "carspect",
    source:      "Carspect",
    displayName: "Carspect",
    color:       "#3d7a3a",
    bookingUrl:  "https://www.carspect.se/boka-tid",
    async scrape({ reg, location }, onProgress) {
      const r = await scrapeTimeslots({ reg, location }, onProgress);
      return { timeslots: (r.timeslots ?? []).map(s => ({ ...s, source: "Carspect" })) };
    },
  },

  {
    id:          "bilprovning",
    source:      "Bilprovningen",       // kept as-is; displayed as "Opus | Bilprovning"
    displayName: "Opus | Bilprovning",
    color:       "#e8540a",
    bookingUrl:  "https://boka.bilprovning.se/vehiclesandproducts",
    scrape:      scrapeBilprovning,     // already stamps source: "Bilprovningen"
  },

  {
    id:          "bilprovningen",
    source:      "Bilprovningen AB",
    displayName: "Bilprovningen",
    color:       "#0057a8",
    bookingUrl:  "https://boka.bilprovningen.se/asb/sv/boka",
    scrape:      scrapeBilprovningen,   // stamps source: "Bilprovningen AB"
  },
];

// Lookup helpers
export const PROVIDER_BY_SOURCE = Object.fromEntries(PROVIDERS.map(p => [p.source, p]));
export const PROVIDER_BY_ID     = Object.fromEntries(PROVIDERS.map(p => [p.id,     p]));
