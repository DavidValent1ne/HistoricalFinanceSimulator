const fs = require("fs");
const { parse } = require("csv-parse/sync");

function toNumber(x) {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs >= commas ? "\t" : ",";
}

function normalizeHeader(h) {
  let s = String(h || "").trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

function parseYear(value) {
  if (value === null || value === undefined) return null;

  const n = toNumber(value);
  if (n !== null) {
    const y = Math.floor(n);
    if (y >= 1800 && y <= 3000) return y;
  }

  const s = String(value);
  const m = s.match(/(\d{4})/);
  if (!m) return null;

  const y = Number(m[1]);
  if (Number.isFinite(y) && y >= 1800 && y <= 3000) return y;
  return null;
}

function loadInflationAnnualFromCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Inflation CSV not found at: ${csvPath}`);
  }

  const raw = fs.readFileSync(csvPath, "utf8");
  const delimiter = detectDelimiter(raw);

  const records = parse(raw, {
    columns: (hdrs) => hdrs.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    delimiter
  });

  let yearKey = null;
  let aveKey = null;

  if (records.length) {
    const keys = Object.keys(records[0]);

    yearKey =
      keys.find((k) => k.toLowerCase() === "year") ||
      keys.find((k) => k.toLowerCase().includes("year")) ||
      keys[0];

    aveKey =
      keys.find((k) => k.toLowerCase() === "ave") ||
      keys.find((k) => k.toLowerCase() === "avg") ||
      keys.find((k) => k.toLowerCase().includes("ave")) ||
      null;
  }

  const monthKeys = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const annual = [];
  for (const r of records) {
    const year = parseYear(r[yearKey]);
    if (!Number.isFinite(year)) continue;

    let avgRate = aveKey ? toNumber(r[aveKey]) : null;

    if (avgRate === null) {
      const vals = [];
      for (const mk of monthKeys) {
        const k = Object.keys(r).find((x) => x.toLowerCase() === mk.toLowerCase());
        if (!k) continue;
        const v = toNumber(r[k]);
        if (v !== null) vals.push(v);
      }
      if (vals.length) avgRate = vals.reduce((a, b) => a + b, 0) / vals.length;
    }

    if (avgRate === null) continue;

    annual.push({ year, avgRatePct: avgRate });
  }

  annual.sort((a, b) => a.year - b.year);

  if (!annual.length) {
    throw new Error(
      `Inflation CSV parsed, but produced 0 usable rows. Check delimiter/headers. Detected delimiter: ${JSON.stringify(delimiter)}`
    );
  }

  const overallAvgRatePct =
    annual.reduce((sum, r) => sum + r.avgRatePct, 0) / annual.length;

  const meta = {
    yearCount: annual.length,
    firstYear: annual[0].year,
    lastYear: annual[annual.length - 1].year,
    overallAvgRatePct
  };

  const byYear = new Map();
  for (const a of annual) byYear.set(a.year, a);

  return { annual, byYear, meta };
}

module.exports = { loadInflationAnnualFromCsv };
