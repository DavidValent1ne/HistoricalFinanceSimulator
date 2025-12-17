const fs = require("fs");
const { parse } = require("csv-parse");

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase();
}

function parseDate(d) {
  // Accept "YYYY-MM-DD" or similar
  const s = String(d).trim();
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  // Normalize to YYYY-MM-DD
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toNumber(x) {
  const n = Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
}

function monthKeyFromDate(yyyyMMdd) {
  // yyyyMMdd: "YYYY-MM-DD"
  return yyyyMMdd.slice(0, 7); // "YYYY-MM"
}

async function loadDailyCsvAndBuildMonthly(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found at: ${csvPath}`);
  }

  const rows = [];
  const parser = fs
    .createReadStream(csvPath)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    );

  let dateCol = null;
  let openCol = null;
  let closeCol = null;

  for await (const record of parser) {
    if (!dateCol) {
      const headers = Object.keys(record).map(normalizeHeader);

      // Try common names
      const originalKeys = Object.keys(record);
      const findKey = (candidates) => {
        for (const cand of candidates) {
          const idx = headers.indexOf(cand);
          if (idx >= 0) return originalKeys[idx];
        }
        return null;
      };

      dateCol = findKey(["date", "day", "time"]);
      openCol = findKey(["open", "open_price", "opening", "o"]);
      closeCol = findKey(["close", "close_price", "closing", "c"]);

      if (!dateCol || !closeCol) {
        throw new Error(
          `CSV must include a date column (date/day) and a close column (close). Found headers: ${Object.keys(record).join(
            ", "
          )}`
        );
      }
    }

    const date = parseDate(record[dateCol]);
    const open = openCol ? toNumber(record[openCol]) : null;
    const close = toNumber(record[closeCol]);

    if (!date || close === null) continue;

    rows.push({ date, open, close });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Build monthly closes: last daily close in each month
  const monthlyMap = new Map(); // monthKey -> { monthKey, lastDailyDate, close }
  for (const r of rows) {
    const mk = monthKeyFromDate(r.date);
    const prev = monthlyMap.get(mk);
    if (!prev || r.date > prev.lastDailyDate) {
      monthlyMap.set(mk, { month: mk, lastDailyDate: r.date, close: r.close });
    }
  }

  const monthly = Array.from(monthlyMap.values())
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => ({
      month: m.month,              // "YYYY-MM"
      monthStart: `${m.month}-01`, // for chart labels
      lastDailyDate: m.lastDailyDate,
      close: m.close
    }));

  const meta = {
    dailyCount: rows.length,
    monthlyCount: monthly.length,
    firstDailyDate: rows[0]?.date || null,
    lastDailyDate: rows[rows.length - 1]?.date || null,
    firstMonth: monthly[0]?.month || null,
    lastMonth: monthly[monthly.length - 1]?.month || null
  };

  return { daily: rows, monthly, meta };
}

module.exports = { loadDailyCsvAndBuildMonthly };
