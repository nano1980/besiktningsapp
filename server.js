import express from "express";
import cors from "cors";
import fs from "fs";
import { scrapeTimeslots, bookTimeslot } from "./scraper.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/timeslots", async (req, res) => {
  const { reg, location } = req.query;
  if (!reg) return res.status(400).json({ error: "reg is required" });
  if (!location) return res.status(400).json({ error: "location is required" });
  try {
    const result = await scrapeTimeslots({ reg: reg.toUpperCase(), location });
    if (!fs.existsSync("./results")) fs.mkdirSync("./results");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rows = result.timeslots.map(s => `"${s.date}","${s.time}","${s.station}","${s.price}"`).join("\n");
    fs.writeFileSync(`./results/timeslots_${reg}_${ts}.csv`, "date,time,station,price\n" + rows);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/book", async (req, res) => {
  const { reg, station, date, time } = req.body;
  if (!reg || !station || !date || !time)
    return res.status(400).json({ error: "reg, station, date, time required" });
  try {
    const result = await bookTimeslot({ reg: reg.toUpperCase(), station, date, time });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => {
  console.log("🚗 Carspect API running at http://localhost:3000");
  console.log("   GET  /timeslots?reg=ABC123&location=Stockholm");
  console.log("   POST /book  { reg, station, date, time }");
});
