#!/usr/bin/env node
import { scrapeTimeslots } from "./scraper.js";
import fs from "fs";

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const reg = get("--reg");
const location = get("--location");
const inspectionType = get("--type");

if (!reg || !location) {
  console.error("Usage: node cli.js --reg <REG> --location <LOCATION>");
  process.exit(1);
}

if (!fs.existsSync("./results")) fs.mkdirSync("./results");
console.log("\n🚗 Carspect Timeslot Agent\n" + "─".repeat(40));

try {
  const result = await scrapeTimeslots({ reg: reg.toUpperCase(), location, inspectionType: inspectionType ?? null });
  console.log(`\n✅ Found ${result.timeslots.length} timeslots`);
  if (result.timeslots.length === 0) {
    console.log("No available timeslots found.");
  } else {
    console.table(result.timeslots);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(`./results/timeslots_${reg}_${ts}.json`, JSON.stringify(result, null, 2));
    console.log(`\n💾 Saved to ./results/`);
  }
} catch (err) {
  console.error("\n❌ Error:", err.message);
  console.error("💡 Check ./results/ for debug screenshots");
  process.exit(1);
}
