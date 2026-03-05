import express from "express";
import cors from "cors";
import fs from "fs";
import { exec } from "child_process";
import { PROVIDERS, PROVIDER_BY_SOURCE } from "./providers.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Vehicle lookup — quick call to Carspect API, no scraping
app.get("/vehicle", async (req, res) => {
  const { reg } = req.query;
  if (!reg) return res.status(400).json({ error: "reg is required" });
  try {
    const r = await fetch(`https://booking-api.muster.se/v1/Vehicle?ChainId=2&PlateNumber=${reg.toUpperCase()}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.carspect.se/" },
    });
    if (!r.ok) return res.status(502).json({ error: "Vehicle lookup failed" });
    const v = await r.json();
    res.json({
      reg:            reg.toUpperCase(),
      model:          v.vehicleBrandAndModel ?? null,
      category:       v.vehicleCategory ?? null,
      color:          v.vehicleColorText ?? null,
      year:           v.vehicleYear ?? null,
      inspectBefore:  v.lastDayToInspect ? v.lastDayToInspect.slice(0, 10) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all registered providers — frontend uses this to build loader rows
app.get("/providers", (_req, res) => {
  res.json(PROVIDERS.map(({ id, source, displayName, color, bookingUrl }) => ({
    id, source, displayName, color, bookingUrl,
  })));
});

app.get("/timeslots", async (req, res) => {
  const { reg, location, provider } = req.query;
  if (!reg)      return res.status(400).json({ error: "reg is required" });
  if (!location) return res.status(400).json({ error: "location is required" });

  // If ?provider=id is given, run only that provider (used for parallel per-provider fetches)
  const targets = provider
    ? PROVIDERS.filter(p => p.id === provider)
    : PROVIDERS;
  if (!targets.length) return res.status(400).json({ error: "Unknown provider" });

  try {
    const results = await Promise.all(
      targets.map(p =>
        p.scrape({ reg: reg.toUpperCase(), location }).catch(err => {
          console.error(`[${p.id}] scrape error: ${err.message}`);
          return { timeslots: [] };
        })
      )
    );

    const all = results.flatMap(r => r.timeslots ?? []);
    all.sort((a, b) => new Date(`${a.date}T${a.time || "00:00"}`) - new Date(`${b.date}T${b.time || "00:00"}`));

    // Save combined CSV only when all providers are fetched together
    if (!provider) {
      if (!fs.existsSync("./results")) fs.mkdirSync("./results");
      const ts   = new Date().toISOString().replace(/[:.]/g, "-");
      const rows = all.map(s => `"${s.date}","${s.time}","${s.station}","${s.price}","${s.source}"`).join("\n");
      fs.writeFileSync(`./results/timeslots_${reg}_${ts}.csv`, "date,time,station,price,source\n" + rows);
    }

    const sources = Object.fromEntries(
      targets.map((p, i) => [p.id, results[i].timeslots?.length ?? 0])
    );

    return res.json({
      success: true,
      timeslots: all,
      inspectionType: "Kontrollbesiktning",
      stations: [],
      sources,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// SSE endpoint — streams step progress for slow providers (bilprovningen)
app.get("/timeslots/stream", async (req, res) => {
  const { reg, location, provider } = req.query;
  if (!reg || !location || !provider) return res.status(400).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const p = PROVIDERS.find(p => p.id === provider);
    if (!p) { send({ type: "error", error: "Unknown provider" }); return res.end(); }
    const result = await p.scrape(
      { reg: reg.toUpperCase(), location },
      (step) => send({ type: "progress", step })
    );
    send({ type: "done", timeslots: result.timeslots ?? [], sources: { [provider]: result.timeslots?.length ?? 0 } });
  } catch (e) {
    send({ type: "error", error: e.message });
  }
  res.end();
});

app.post("/book", (req, res) => {
  const { reg, station, date, time, source } = req.body;
  if (!reg || !station || !date || !time)
    return res.status(400).json({ error: "reg, station, date, time required" });

  const provider = PROVIDER_BY_SOURCE[source];
  const url = provider?.bookingUrl ?? "https://www.carspect.se/boka-tid";
  exec(`open "${url}"`);
  return res.json({ success: true, reg, station, date, time, status: "tab_opened" });
});

// Serve static files AFTER API routes so routes always take precedence
app.use(express.static(".", { maxAge: 0, etag: false }));

app.listen(3000, () => {
  console.log("🚗 Besiktningstider API v1.2.9 running at http://localhost:3000");
  console.log("   GET  /timeslots?reg=ABC123&location=Stockholm");
  console.log("   GET  /providers");
  console.log("   POST /book  { reg, station, date, time, source }");
});
