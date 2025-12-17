/* -----------------------------
   Global state
------------------------------ */
let SP = null;          // { monthly: [{month, open, close}], meta: {firstMonth,lastMonth} }
let INF = null;         // { byYear: Map(year->avgPct), meta: {firstYear,lastYear,overallAvgPct} }
let META = null;

let dcaChart, retChart, successChart, infChart, infSweepChart;

/* -----------------------------
   Helpers
------------------------------ */
function money(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function num(n, digits = 4) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function pct(n) {
  if (!Number.isFinite(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}

function pctNum(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2) + "%";
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function monthToIndex(month) {
  const [yStr, mStr] = String(month).split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return y * 12 + (m - 1);
}

function setHint(el, msg, isError) {
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("error", Boolean(isError && msg));
}

function setDisabled(btn, disabled) {
  if (!btn) return;
  btn.disabled = Boolean(disabled);
}

function setStats(el, lines) {
  el.innerHTML = "";
  for (const { label, value } of lines) {
    const div = document.createElement("div");
    div.className = "statline";
    div.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    el.appendChild(div);
  }
}

/* -----------------------------
   CSV Loading (PapaParse)
------------------------------ */
async function fetchText(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.text();
}

function papaParse(text) {
  const parsed = Papa.parse(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true
  });
  if (parsed.errors?.length) {
    // not fatal, but helpful
    console.warn("CSV parse warnings:", parsed.errors.slice(0, 5));
  }
  return parsed.data;
}

function normalizeKey(s) {
  return String(s || "").trim().toLowerCase();
}

function pickField(row, candidates) {
  const keys = Object.keys(row);
  const map = new Map(keys.map(k => [normalizeKey(k), k]));
  for (const c of candidates) {
    const got = map.get(normalizeKey(c));
    if (got !== undefined) return row[got];
  }
  return undefined;
}

/* -----------------------------
   S&P: daily -> monthly aggregation
   Expected columns: date/day + open + close
------------------------------ */
function buildMonthlyFromDaily(dailyRows) {
  // collect (date, open, close) rows with valid date
  const cleaned = [];
  for (const r of dailyRows) {
    const date = pickField(r, ["day", "date", "datetime"]);
    const open = pickField(r, ["open", "Open"]);
    const close = pickField(r, ["close", "Close"]);

    const ds = String(date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) continue;
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;

    cleaned.push({ date: ds, open: Number(open), close: Number(close) });
  }

  cleaned.sort((a, b) => a.date.localeCompare(b.date));

  // aggregate by YYYY-MM
  const byMonth = new Map(); // month -> {firstDate, lastDate, open, close}
  for (const r of cleaned) {
    const month = r.date.slice(0, 7);
    const cur = byMonth.get(month);
    if (!cur) {
      byMonth.set(month, {
        month,
        firstDate: r.date,
        lastDate: r.date,
        open: r.open,
        close: r.close
      });
    } else {
      // first open stays (earliest)
      cur.lastDate = r.date;
      cur.close = r.close; // last close updates
    }
  }

  const monthly = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
  if (!monthly.length) throw new Error("No monthly data could be built from sp500.csv");

  return {
    monthly: monthly.map(m => ({ month: m.month, open: m.open, close: m.close })),
    meta: { firstMonth: monthly[0].month, lastMonth: monthly[monthly.length - 1].month, monthlyCount: monthly.length }
  };
}

/* -----------------------------
   Inflation: use Ave column (annual avg %)
   Expected columns: Year ... Ave
------------------------------ */
function loadInflationAnnual(rows) {
  const byYear = new Map();

  // Detect keys
  for (const r of rows) {
    const year = pickField(r, ["Year", "year"]);
    if (!Number.isFinite(year)) continue;

    // Ave could be "Ave" or "Avg" etc
    let ave = pickField(r, ["Ave", "AVE", "Avg", "Average", "avg"]);
    if (!Number.isFinite(ave)) {
      // Some files might have ave in last column without header; best effort:
      // if row has numeric values, take the last numeric as ave
      const vals = Object.values(r).filter(v => Number.isFinite(v));
      if (vals.length) ave = vals[vals.length - 1];
    }
    if (!Number.isFinite(ave)) continue;

    byYear.set(Number(year), Number(ave));
  }

  const years = Array.from(byYear.keys()).sort((a, b) => a - b);
  if (!years.length) throw new Error("No inflation years parsed from us_inflation.csv");

  const firstYear = years[0];
  const lastYear = years[years.length - 1];

  let sum = 0;
  for (const y of years) sum += byYear.get(y);
  const overallAvgPct = sum / years.length;

  return {
    byYear,
    meta: {
      firstYear,
      lastYear,
      yearCount: years.length,
      overallAvgPct
    }
  };
}

/* -----------------------------
   Market returns (monthly)
------------------------------ */
function buildMonthlyReturns(monthly) {
  const r = new Array(monthly.length).fill(0);
  for (let i = 1; i < monthly.length; i++) {
    const prev = Number(monthly[i - 1].close);
    const cur = Number(monthly[i].close);
    if (Number.isFinite(prev) && prev > 0 && Number.isFinite(cur)) r[i] = cur / prev - 1;
    else r[i] = 0;
  }
  return r;
}

function findMonthIndex(monthly, monthStr) {
  const idx = monthly.findIndex(m => m.month === monthStr);
  if (idx >= 0) return idx;

  const want = monthToIndex(monthStr);
  if (want === null) return -1;
  for (let i = 0; i < monthly.length; i++) {
    const have = monthToIndex(monthly[i].month);
    if (have === want) return i;
  }
  return -1;
}

/* -----------------------------
   Inflation monthly compounding from annual %
   Used for the "inflation-adjusted spending" retirement method
------------------------------ */
function monthlyInflRateFromAnnualPct(annualPct) {
  const a = (Number.isFinite(annualPct) ? annualPct : 3) / 100;
  if (a < -0.99) return -0.99;
  return Math.pow(1 + a, 1 / 12) - 1;
}

/* -----------------------------
   Simulations
------------------------------ */
function runDcaMonthly({ monthly, initialLumpSum, monthlyContribution, startMonth, endMonth }) {
  const startIdx = findMonthIndex(monthly, startMonth);
  const endIdx = findMonthIndex(monthly, endMonth);
  if (startIdx < 0) throw new Error(`Start month not found: ${startMonth}`);
  if (endIdx < 0) throw new Error(`End month not found: ${endMonth}`);
  if (startIdx > endIdx) throw new Error("Start month must be <= end month");

  const returns = buildMonthlyReturns(monthly);

  let balance = Number.isFinite(initialLumpSum) ? initialLumpSum : 0;
  let contributed = balance;

  const series = [];
  for (let i = startIdx; i <= endIdx; i++) {
    balance *= (1 + returns[i]);
    balance += monthlyContribution;
    contributed += monthlyContribution;
    series.push({ month: monthly[i].month, value: balance });
  }

  return { contributed, endingValue: balance, series };
}

function computeWithdrawal({
  mode,
  initialBalance,
  balanceAfterMarket,
  withdrawRateDecimal,
  frequency,
  isWithdrawalMonth,
  // inflation-adjusted spending
  inflationBasePeriodWithdraw,
  inflationFactor,
  // guardrails
  guardrailsState,
  guardrailsCfg,
  ytdReturnAfterMarket
}) {
  if (!isWithdrawalMonth) return { withdrawal: 0, guardrailsRate: guardrailsState?.currentRate ?? null };

  if (mode === "percentOfInitial") {
    const annual = initialBalance * withdrawRateDecimal;
    return { withdrawal: frequency === "monthly" ? annual / 12 : annual, guardrailsRate: null };
  }

  // IMPORTANT: your updated definition:
  // NOT recalculated off current balance.
  // It is a planned spending amount based on INITIAL balance, scaled monthly by prior-month inflation.
  if (mode === "percentOfCurrent") {
    return { withdrawal: inflationBasePeriodWithdraw * inflationFactor, guardrailsRate: null };
  }

  if (mode === "guardrails") {
    if (Number.isFinite(ytdReturnAfterMarket)) {
      if (ytdReturnAfterMarket > 0.08) guardrailsState.currentRate = clamp(guardrailsState.currentRate + guardrailsCfg.step, guardrailsCfg.minRate, guardrailsCfg.maxRate);
      if (ytdReturnAfterMarket < 0.03) guardrailsState.currentRate = clamp(guardrailsState.currentRate - guardrailsCfg.step, guardrailsCfg.minRate, guardrailsCfg.maxRate);
    }

    const annual = balanceAfterMarket * guardrailsState.currentRate;
    let w = frequency === "monthly" ? annual / 12 : annual;
    if (guardrailsCfg.minDollarFloor > 0) w = Math.max(w, guardrailsCfg.minDollarFloor);
    return { withdrawal: w, guardrailsRate: guardrailsState.currentRate };
  }

  throw new Error(`Unknown mode: ${mode}`);
}

function runRetirementMonthly({
  monthly,
  initialBalance,
  startMonth,
  durationYears,
  withdrawMode,
  withdrawPct,
  withdrawFrequency,
  // inflation-adjusted option
  annualInflationPct,
  // guardrails option
  guardrailsMinPct,
  guardrailsMaxPct,
  guardrailsMinDollar
}) {
  const startIdx = findMonthIndex(monthly, startMonth);
  if (startIdx < 0) throw new Error(`Start month not found: ${startMonth}`);

  const endIdxExclusive = startIdx + durationYears * 12;
  if (endIdxExclusive > monthly.length) throw new Error(`Not enough data for ${durationYears} years from ${startMonth}`);

  const returns = buildMonthlyReturns(monthly);

  const withdrawRateDecimal = (withdrawPct / 100);
  if (!Number.isFinite(withdrawRateDecimal) || withdrawRateDecimal <= 0) throw new Error("Withdraw % must be > 0");

  // inflation-adjusted spending (based on initial balance)
  const monthlyInfl = monthlyInflRateFromAnnualPct(annualInflationPct ?? 3);
  let inflationFactor = 1;

  // base spending amount derived from initial balance (so it won't shrink if market tanks)
  const inflationBasePeriodWithdraw =
    withdrawMode === "percentOfCurrent"
      ? (withdrawFrequency === "monthly"
          ? (initialBalance * withdrawRateDecimal) / 12
          : (initialBalance * withdrawRateDecimal))
      : 0;

  // guardrails setup
  const guardrailsState = { currentRate: null };
  const guardrailsCfg = { minRate: 0, maxRate: 1, step: 0.0025, minDollarFloor: 0 };

  if (withdrawMode === "guardrails") {
    const start = withdrawRateDecimal;
    const minR = (guardrailsMinPct / 100);
    const maxR = (guardrailsMaxPct / 100);
    if (!Number.isFinite(minR) || !Number.isFinite(maxR) || minR > maxR) throw new Error("Guardrails min/max invalid");
    guardrailsState.currentRate = clamp(start, minR, maxR);
    guardrailsCfg.minRate = minR;
    guardrailsCfg.maxRate = maxR;
    guardrailsCfg.minDollarFloor = Number.isFinite(guardrailsMinDollar) ? Math.max(0, guardrailsMinDollar) : 0;
  }

  let balance = initialBalance;
  let success = true;
  let totalWithdrawn = 0;

  let highestBalance = balance;
  let lowestBalance = balance;

  let peak = balance;
  let maxDrawdown = 0;

  let currentYear = Number(monthly[startIdx].month.slice(0, 4));
  let yearStartBalance = balance;

  const series = [];

  for (let i = startIdx; i < endIdxExclusive; i++) {
    const monthStr = monthly[i].month;
    const y = Number(monthStr.slice(0, 4));
    const m = Number(monthStr.slice(5, 7));

    if (y !== currentYear) {
      currentYear = y;
      yearStartBalance = balance;
    }

    // market return
    balance *= (1 + returns[i]);
    const ytdReturnAfterMarket = yearStartBalance > 0 ? (balance / yearStartBalance - 1) : 0;

    const isWithdrawalMonth = withdrawFrequency === "monthly" ? true : (m === 1);

    const { withdrawal, guardrailsRate } = computeWithdrawal({
      mode: withdrawMode,
      initialBalance,
      balanceAfterMarket: balance,
      withdrawRateDecimal,
      frequency: withdrawFrequency,
      isWithdrawalMonth,
      inflationBasePeriodWithdraw,
      inflationFactor,
      guardrailsState,
      guardrailsCfg,
      ytdReturnAfterMarket
    });

    const w = Math.min(balance, Math.max(0, withdrawal));
    balance -= w;
    totalWithdrawn += w;

    if (balance <= 0) {
      balance = 0;
      success = false;
    }

    highestBalance = Math.max(highestBalance, balance);
    lowestBalance = Math.min(lowestBalance, balance);

    peak = Math.max(peak, balance);
    const dd = peak > 0 ? (peak - balance) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);

    series.push({
      month: monthStr,
      value: balance,
      withdrawal: w,
      guardrailsRatePct: guardrailsRate !== null ? guardrailsRate * 100 : null,
      inflationFactor: withdrawMode === "percentOfCurrent" ? inflationFactor : null
    });

    // Apply “prior month inflation” to NEXT month’s withdrawal target:
    if (withdrawMode === "percentOfCurrent") {
      inflationFactor *= (1 + monthlyInfl);
    }

    if (!success) break;
  }

  return { success, totalWithdrawn, endingValue: balance, maxDrawdown, highestBalance, lowestBalance, series };
}

function runRetirementSuccessByStartYear({
  monthly,
  initialBalance,
  durationYears,
  withdrawMode,
  withdrawPct,
  withdrawFrequency,
  annualInflationPct,
  guardrailsMinPct,
  guardrailsMaxPct,
  guardrailsMinDollar
}) {
  const returns = buildMonthlyReturns(monthly);

  const withdrawRateDecimal = (withdrawPct / 100);
  if (!Number.isFinite(withdrawRateDecimal) || withdrawRateDecimal <= 0) throw new Error("Withdraw % must be > 0");

  const monthlyInfl = monthlyInflRateFromAnnualPct(annualInflationPct ?? 3);

  const results = [];
  const endingBalances = [];

  let highestBalanceHit = -Infinity;
  let lowestBalanceHit = Infinity;

  for (let startIdx = 0; startIdx < monthly.length; startIdx++) {
    const ms = monthly[startIdx].month;
    const m = Number(ms.slice(5, 7));
    if (m !== 1) continue; // January starts only

    const endIdxExclusive = startIdx + durationYears * 12;
    if (endIdxExclusive > monthly.length) break;

    let balance = initialBalance;
    let success = true;

    let highest = balance;
    let lowest = balance;

    // inflation-adjusted spending
    let inflationFactor = 1;
    const inflationBasePeriodWithdraw =
      withdrawMode === "percentOfCurrent"
        ? (withdrawFrequency === "monthly"
            ? (initialBalance * withdrawRateDecimal) / 12
            : (initialBalance * withdrawRateDecimal))
        : 0;

    // guardrails
    const guardrailsState = { currentRate: null };
    const guardrailsCfg = { minRate: 0, maxRate: 1, step: 0.0025, minDollarFloor: 0 };

    if (withdrawMode === "guardrails") {
      const minR = (guardrailsMinPct / 100);
      const maxR = (guardrailsMaxPct / 100);
      guardrailsState.currentRate = clamp(withdrawRateDecimal, minR, maxR);
      guardrailsCfg.minRate = minR;
      guardrailsCfg.maxRate = maxR;
      guardrailsCfg.minDollarFloor = Number.isFinite(guardrailsMinDollar) ? Math.max(0, guardrailsMinDollar) : 0;
    }

    let currentYear = Number(ms.slice(0, 4));
    let yearStartBalance = balance;

    for (let i = startIdx; i < endIdxExclusive; i++) {
      const monthStr = monthly[i].month;
      const y = Number(monthStr.slice(0, 4));
      const mon = Number(monthStr.slice(5, 7));

      if (y !== currentYear) {
        currentYear = y;
        yearStartBalance = balance;
      }

      balance *= (1 + returns[i]);
      const ytdReturnAfterMarket = yearStartBalance > 0 ? (balance / yearStartBalance - 1) : 0;

      const isWithdrawalMonth = withdrawFrequency === "monthly" ? true : (mon === 1);

      const { withdrawal } = computeWithdrawal({
        mode: withdrawMode,
        initialBalance,
        balanceAfterMarket: balance,
        withdrawRateDecimal,
        frequency: withdrawFrequency,
        isWithdrawalMonth,
        inflationBasePeriodWithdraw,
        inflationFactor,
        guardrailsState,
        guardrailsCfg,
        ytdReturnAfterMarket
      });

      const w = Math.min(balance, Math.max(0, withdrawal));
      balance -= w;

      if (balance <= 0) {
        balance = 0;
        success = false;
        break;
      }

      highest = Math.max(highest, balance);
      lowest = Math.min(lowest, balance);

      if (withdrawMode === "percentOfCurrent") {
        inflationFactor *= (1 + monthlyInfl);
      }
    }

    highestBalanceHit = Math.max(highestBalanceHit, highest);
    lowestBalanceHit = Math.min(lowestBalanceHit, lowest);

    const startYear = Number(ms.slice(0, 4));
    results.push({
      startYear,
      passed: success,
      startingBalance: initialBalance,
      highestBalance: highest,
      lowestBalance: lowest,
      endingBalance: balance
    });
    endingBalances.push(balance);
  }

  const total = results.length;
  const successes = results.filter(r => r.passed).length;

  return {
    summary: {
      totalStartYearsTested: total,
      successes,
      successRate: total ? successes / total : 0,
      averageEndingBalance: total ? endingBalances.reduce((a, b) => a + b, 0) / total : null,
      medianEndingBalance: total ? median(endingBalances) : null,
      highestBalanceHit: Number.isFinite(highestBalanceHit) ? highestBalanceHit : null,
      lowestBalanceHit: Number.isFinite(lowestBalanceHit) ? lowestBalanceHit : null
    },
    results
  };
}

/* -----------------------------
   Inflation calculators
------------------------------ */
function runInflationWindow({ amount, startYear, durationYears }) {
  const years = Math.floor(durationYears);
  const sY = Math.floor(startYear);
  const eY = sY + years - 1;

  if (sY < INF.meta.firstYear || eY > INF.meta.lastYear) {
    throw new Error(`Inflation window must be within ${INF.meta.firstYear}–${INF.meta.lastYear}`);
  }

  let factor = 1;
  const series = [];

  for (let y = sY; y <= eY; y++) {
    const pct = INF.byYear.get(y);
    if (!Number.isFinite(pct)) throw new Error(`Missing inflation data for year ${y}`);

    const mult = 1 + (pct / 100);
    if (mult <= 0) throw new Error(`Non-positive inflation multiplier at year ${y} (${pct}%)`);

    factor *= mult;

    series.push({
      year: y,
      avgInflationPct: pct,
      cumulativeFactor: factor,
      futureEquivalent: amount * factor,
      realValueInStartDollars: amount / factor
    });
  }

  return {
    amount,
    startYear: sY,
    endYear: eY,
    durationYears: years,
    cumulativeInflationFactor: factor,
    futureEquivalentSameBuyingPower: amount * factor,
    purchasingPowerInStartDollars: amount / factor,
    series
  };
}

function runInflationSweep({ amount, durationYears }) {
  const years = Math.floor(durationYears);
  const first = INF.meta.firstYear;
  const last = INF.meta.lastYear;

  const maxStartYear = last - years + 1;
  if (maxStartYear < first) throw new Error("Duration too long for inflation dataset");

  const results = [];
  for (let startYear = first; startYear <= maxStartYear; startYear++) {
    const endYear = startYear + years - 1;

    let factor = 1;
    let sumPct = 0;

    for (let y = startYear; y <= endYear; y++) {
      const pct = INF.byYear.get(y);
      if (!Number.isFinite(pct)) throw new Error(`Missing inflation data for year ${y}`);
      const mult = 1 + (pct / 100);
      if (mult <= 0) throw new Error(`Non-positive inflation multiplier at year ${y} (${pct}%)`);
      factor *= mult;
      sumPct += pct;
    }

    results.push({
      startYear,
      endYear,
      startAmount: amount,
      endAmount: amount * factor,
      realValueInStartDollars: amount / factor,
      cumulativeFactor: factor,
      avgInflationPct: sumPct / years
    });
  }

  return {
    amount,
    durationYears: years,
    summary: {
      startYearsTested: results.length,
      firstStartYear: first,
      lastStartYear: maxStartYear
    },
    results
  };
}

/* -----------------------------
   Charts
------------------------------ */
function makeLineChart(canvas, labels, datasets, yTitle = "Value ($)") {
  return new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "rgba(255,255,255,0.80)" } } },
      scales: {
        x: { ticks: { color: "rgba(255,255,255,0.65)", maxTicksLimit: 10 }, grid: { color: "rgba(255,255,255,0.08)" } },
        y: { ticks: { color: "rgba(255,255,255,0.65)" }, grid: { color: "rgba(255,255,255,0.08)" }, title: { display: true, text: yTitle, color: "rgba(255,255,255,0.70)" } }
      }
    }
  });
}

function makeBarChart(canvas, labels, datasets, yTitle) {
  return new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "rgba(255,255,255,0.80)" } } },
      scales: {
        x: { ticks: { color: "rgba(255,255,255,0.65)", maxTicksLimit: 14 }, grid: { color: "rgba(255,255,255,0.08)" } },
        y: { ticks: { color: "rgba(255,255,255,0.65)" }, grid: { color: "rgba(255,255,255,0.08)" }, title: { display: true, text: yTitle, color: "rgba(255,255,255,0.70)" } }
      }
    }
  });
}

function makeInflationSweepChart(canvas, labels, futureEq, realValue) {
  return new Chart(canvas.getContext("2d"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Future equivalent (same buying power)",
          data: futureEq,
          backgroundColor: "rgba(70, 140, 255, 0.55)",
          borderColor: "rgba(70, 140, 255, 0.95)",
          borderWidth: 1
        },
        {
          type: "line",
          label: "Real value (in start-year dollars)",
          data: realValue,
          borderColor: "rgba(255, 70, 70, 0.95)",
          backgroundColor: "rgba(255, 70, 70, 0.25)",
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "rgba(255,255,255,0.80)" } } },
      scales: {
        x: { ticks: { color: "rgba(255,255,255,0.65)", maxTicksLimit: 14 }, grid: { color: "rgba(255,255,255,0.08)" } },
        y: { ticks: { color: "rgba(255,255,255,0.65)" }, grid: { color: "rgba(255,255,255,0.08)" }, title: { display: true, text: "Dollars ($)", color: "rgba(255,255,255,0.70)" } }
      }
    }
  });
}

/* -----------------------------
   UI wiring + validation
------------------------------ */
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = {
    dca: document.getElementById("panel-dca"),
    retire: document.getElementById("panel-retire"),
    success: document.getElementById("panel-success"),
    inflation: document.getElementById("panel-inflation")
  };

  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      Object.values(panels).forEach((p) => p.classList.remove("active"));
      panels[t.dataset.tab].classList.add("active");
    });
  });
}

function clampMonthInput(el, min, max) {
  if (!el) return;
  el.min = min;
  el.max = max;
  if (el.value < min) el.value = min;
  if (el.value > max) el.value = max;
}

function validateDcaDates() {
  const start = document.getElementById("dcaStart").value;
  const end = document.getElementById("dcaEnd").value;
  const hintEl = document.getElementById("dcaDateHint");
  const btn = document.getElementById("runDca");

  let msg = "";
  if (!start || !end) msg = "Choose both a start month and end month.";
  else if (start < META.firstMonth || start > META.lastMonth || end < META.firstMonth || end > META.lastMonth) msg = `Dates must be within ${META.firstMonth} → ${META.lastMonth}.`;
  else if (start > end) msg = "Start month must be before (or equal to) end month.";

  setHint(hintEl, msg, Boolean(msg));
  setDisabled(btn, Boolean(msg));
}

function validateRetirementDates() {
  const start = document.getElementById("retStart").value;
  const years = Number(document.getElementById("retYears").value);
  const hintEl = document.getElementById("retDateHint");
  const btn = document.getElementById("runRet");

  let msg = "";
  if (!start) msg = "Choose a start month.";
  else if (start < META.firstMonth || start > META.lastMonth) msg = `Start month must be within ${META.firstMonth} → ${META.lastMonth}.`;
  else if (!Number.isFinite(years) || years <= 0) msg = "Duration must be > 0 years.";
  else {
    const startIdx = monthToIndex(start);
    const lastIdx = monthToIndex(META.lastMonth);
    if (startIdx === null || lastIdx === null) msg = "Invalid month format.";
    else if (startIdx + years * 12 > lastIdx) msg = `Not enough S&P data for ${years} years from ${start}. Try an earlier start month.`;
  }

  setHint(hintEl, msg, Boolean(msg));
  setDisabled(btn, Boolean(msg));
}

function validateInflationCalc() {
  const startYear = Number(document.getElementById("infStartYear").value);
  const years = Number(document.getElementById("infYears").value);
  const hintEl = document.getElementById("infHint");
  const btn = document.getElementById("runInflation");

  let msg = "";
  if (!Number.isFinite(startYear)) msg = "Start year is required.";
  else if (startYear < INF.meta.firstYear || startYear > INF.meta.lastYear) msg = `Start year must be within ${INF.meta.firstYear} → ${INF.meta.lastYear}.`;
  else if (!Number.isFinite(years) || years <= 0) msg = "Duration must be > 0 years.";
  else if (startYear + years - 1 > INF.meta.lastYear) msg = `That window ends after inflation data (${INF.meta.lastYear}).`;

  setHint(hintEl, msg, Boolean(msg));
  setDisabled(btn, Boolean(msg));
}

function validateInflationSweep() {
  const years = Number(document.getElementById("infSweepYears").value);
  const hintEl = document.getElementById("infSweepHint");
  const btn = document.getElementById("runInflationSweep");

  const maxDuration = (INF.meta.lastYear - INF.meta.firstYear + 1);

  let msg = "";
  if (!Number.isFinite(years) || years <= 0) msg = "Duration must be > 0 years.";
  else if (years > maxDuration) msg = `Max duration for this inflation dataset is ${maxDuration} years.`;

  setHint(hintEl, msg, Boolean(msg));
  setDisabled(btn, Boolean(msg));
}

function validateAll() {
  validateDcaDates();
  validateRetirementDates();
  validateInflationCalc();
  validateInflationSweep();
}

function toggleRetirementModeUI() {
  const mode = document.getElementById("retMode").value;
  const std = document.getElementById("retStandardBox");
  const gr = document.getElementById("retGuardrailsBox");
  const more = document.getElementById("retMore");
  const inflOpts = document.getElementById("retInflOpts");

  if (mode === "guardrails") {
    std.style.display = "none";
    gr.style.display = "grid";
  } else {
    std.style.display = "grid";
    gr.style.display = "none";
  }

  // Hide “more options” unless inflation-adjusted spending is selected
  if (more) more.style.display = (mode === "percentOfCurrent") ? "block" : "none";
  if (inflOpts) inflOpts.style.display = (mode === "percentOfCurrent") ? "grid" : "none";
}

function toggleSuccessModeUI() {
  const mode = document.getElementById("sMode").value;
  const std = document.getElementById("sStandardBox");
  const gr = document.getElementById("sGuardrailsBox");
  const more = document.getElementById("sMore");
  const inflOpts = document.getElementById("sInflOpts");

  if (mode === "guardrails") {
    std.style.display = "none";
    gr.style.display = "grid";
  } else {
    std.style.display = "grid";
    gr.style.display = "none";
  }

  if (more) more.style.display = (mode === "percentOfCurrent") ? "block" : "none";
  if (inflOpts) inflOpts.style.display = (mode === "percentOfCurrent") ? "grid" : "none";
}

/* -----------------------------
   Run handlers
------------------------------ */
async function runDca() {
  const initialLumpSum = Number(document.getElementById("dcaLumpSum").value);
  const monthlyContribution = Number(document.getElementById("dcaMonthly").value);
  const startMonth = document.getElementById("dcaStart").value;
  const endMonth = document.getElementById("dcaEnd").value;

  const out = runDcaMonthly({
    monthly: SP.monthly,
    initialLumpSum: Number.isFinite(initialLumpSum) ? Math.max(0, initialLumpSum) : 0,
    monthlyContribution,
    startMonth,
    endMonth
  });

  setStats(document.getElementById("dcaStats"), [
    { label: "Initial lump sum", value: money(Number.isFinite(initialLumpSum) ? initialLumpSum : 0) },
    { label: "Total contributed", value: money(out.contributed) },
    { label: "Ending value", value: money(out.endingValue) },
    { label: "Multiple on contributions", value: out.contributed > 0 ? (out.endingValue / out.contributed).toFixed(2) + "×" : "—" }
  ]);

  const labels = out.series.map(p => p.month);
  const values = out.series.map(p => p.value);

  if (dcaChart) dcaChart.destroy();
  dcaChart = makeLineChart(document.getElementById("dcaChart"), labels, [
    { label: "Portfolio value", data: values, tension: 0.2, pointRadius: 0 }
  ], "Portfolio value ($)");
}

async function runRetirement() {
  const initialBalance = Number(document.getElementById("retInitial").value);
  const startMonth = document.getElementById("retStart").value;
  const durationYears = Number(document.getElementById("retYears").value);
  const withdrawMode = document.getElementById("retMode").value;
  const withdrawFrequency = document.getElementById("retFreq").value;

  let withdrawPct;
  let annualInflationPct = 3;

  let guardrailsMinPct, guardrailsMaxPct, guardrailsMinDollar;

  if (withdrawMode === "guardrails") {
    withdrawPct = Number(document.getElementById("retGStartPct").value);
    guardrailsMinPct = Number(document.getElementById("retGMinPct").value);
    guardrailsMaxPct = Number(document.getElementById("retGMaxPct").value);
    const raw = document.getElementById("retGMinDollar").value;
    guardrailsMinDollar = raw === "" ? 0 : Number(raw);
  } else {
    withdrawPct = Number(document.getElementById("retWithdrawValue").value);
    if (withdrawMode === "percentOfCurrent") {
      const raw = document.getElementById("retAnnualInfl").value;
      annualInflationPct = raw === "" ? 3 : Number(raw);
    }
  }

  const out = runRetirementMonthly({
    monthly: SP.monthly,
    initialBalance,
    startMonth,
    durationYears,
    withdrawMode,
    withdrawPct,
    withdrawFrequency,
    annualInflationPct,
    guardrailsMinPct,
    guardrailsMaxPct,
    guardrailsMinDollar
  });

  setStats(document.getElementById("retStats"), [
    { label: "Success (never hit $0)", value: out.success ? "Yes" : "No" },
    { label: "Total withdrawn", value: money(out.totalWithdrawn) },
    { label: "Ending value", value: money(out.endingValue) },
    { label: "Max drawdown", value: pct(out.maxDrawdown) }
  ]);

  const labels = out.series.map(p => p.month);
  const values = out.series.map(p => p.value);
  const withdrawals = out.series.map(p => p.withdrawal);

  if (retChart) retChart.destroy();
  retChart = makeLineChart(document.getElementById("retChart"), labels, [
    { label: "Portfolio value", data: values, tension: 0.2, pointRadius: 0 },
    { label: "Withdrawal (period)", data: withdrawals, tension: 0.2, pointRadius: 0 }
  ], "Dollars ($)");
}

function renderSuccessTable(results) {
  const tbody = document.getElementById("successTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const r of results) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.startYear}</td>
      <td>${r.passed ? "Passed" : "Failed"}</td>
      <td>${money(r.startingBalance)}</td>
      <td>${money(r.highestBalance)}</td>
      <td>${money(r.lowestBalance)}</td>
      <td>${money(r.endingBalance)}</td>
    `;
    tbody.appendChild(tr);
  }
  if (!results.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="muted-cell">No results.</td>`;
    tbody.appendChild(tr);
  }
}

async function runSuccess() {
  const initialBalance = Number(document.getElementById("sInitial").value);
  const durationYears = Number(document.getElementById("sYears").value);
  const withdrawMode = document.getElementById("sMode").value;
  const withdrawFrequency = document.getElementById("sFreq").value;

  let withdrawPct;
  let annualInflationPct = 3;

  let guardrailsMinPct, guardrailsMaxPct, guardrailsMinDollar;

  if (withdrawMode === "guardrails") {
    withdrawPct = Number(document.getElementById("sGStartPct").value);
    guardrailsMinPct = Number(document.getElementById("sGMinPct").value);
    guardrailsMaxPct = Number(document.getElementById("sGMaxPct").value);
    const raw = document.getElementById("sGMinDollar").value;
    guardrailsMinDollar = raw === "" ? 0 : Number(raw);
  } else {
    withdrawPct = Number(document.getElementById("sWithdrawValue").value);
    if (withdrawMode === "percentOfCurrent") {
      const raw = document.getElementById("sAnnualInfl").value;
      annualInflationPct = raw === "" ? 3 : Number(raw);
    }
  }

  const out = runRetirementSuccessByStartYear({
    monthly: SP.monthly,
    initialBalance,
    durationYears,
    withdrawMode,
    withdrawPct,
    withdrawFrequency,
    annualInflationPct,
    guardrailsMinPct,
    guardrailsMaxPct,
    guardrailsMinDollar
  });

  const s = out.summary;

  setStats(document.getElementById("successStats"), [
    { label: "Start years tested", value: s.totalStartYearsTested.toLocaleString() },
    { label: "Successes", value: s.successes.toLocaleString() },
    { label: "Success rate", value: pct(s.successRate) },
    { label: "Average ending balance", value: money(s.averageEndingBalance) },
    { label: "Median ending balance", value: money(s.medianEndingBalance) },
    { label: "Highest balance hit (any run)", value: money(s.highestBalanceHit) },
    { label: "Lowest balance hit (any run)", value: money(s.lowestBalanceHit) }
  ]);

  const labels = out.results.map(r => String(r.startYear));
  const passedEnding = out.results.map(r => r.passed ? r.endingBalance : null);
  const failedEnding = out.results.map(r => !r.passed ? r.endingBalance : null);

  if (successChart) successChart.destroy();
  successChart = makeBarChart(document.getElementById("successChart"), labels, [
    { label: "Ending balance (passed)", data: passedEnding },
    { label: "Ending balance (failed)", data: failedEnding }
  ], "Ending balance ($)");

  renderSuccessTable(out.results);
}

async function runInflationCalc() {
  const amount = Number(document.getElementById("infAmount").value);
  const startYear = Number(document.getElementById("infStartYear").value);
  const durationYears = Number(document.getElementById("infYears").value);

  const out = runInflationWindow({ amount, startYear, durationYears });

  setStats(document.getElementById("infStats"), [
    { label: "Period", value: `${out.startYear} → ${out.endYear} (${out.durationYears} yrs)` },
    { label: "Cumulative inflation factor", value: num(out.cumulativeInflationFactor) + "×" },
    { label: "Future equivalent (same buying power)", value: money(out.futureEquivalentSameBuyingPower) },
    { label: "Real value (in start-year dollars)", value: money(out.purchasingPowerInStartDollars) }
  ]);

  const labels = out.series.map(p => String(p.year));
  const futureEq = out.series.map(p => p.futureEquivalent);
  const realVal = out.series.map(p => p.realValueInStartDollars);

  if (infChart) infChart.destroy();
  infChart = makeLineChart(document.getElementById("infChart"), labels, [
    { label: "Future equivalent (same buying power)", data: futureEq, tension: 0.2, pointRadius: 0 },
    { label: "Real value (in start-year dollars)", data: realVal, tension: 0.2, pointRadius: 0 }
  ], "Dollars ($)");
}

function renderInflationSweepTable(results) {
  const tbody = document.getElementById("infSweepTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const r of results) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.startYear}</td>
      <td>${r.endYear}</td>
      <td>${money(r.startAmount)}</td>
      <td>${money(r.endAmount)}</td>
      <td>${num(r.cumulativeFactor)}×</td>
      <td>${pctNum(r.avgInflationPct)}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function runInflationSweepCalc() {
  const amount = Number(document.getElementById("infSweepAmount").value);
  const durationYears = Number(document.getElementById("infSweepYears").value);

  const out = runInflationSweep({ amount, durationYears });

  setStats(document.getElementById("infSweepStats"), [
    { label: "Start years tested", value: out.summary.startYearsTested.toLocaleString() },
    { label: "Start-year range", value: `${out.summary.firstStartYear} → ${out.summary.lastStartYear}` },
    { label: "Window length", value: `${out.durationYears} years (inclusive)` }
  ]);

  const labels = out.results.map(r => String(r.startYear));
  const futureEq = out.results.map(r => r.endAmount);
  const realVal = out.results.map(r => r.realValueInStartDollars);

  if (infSweepChart) infSweepChart.destroy();
  infSweepChart = makeInflationSweepChart(document.getElementById("infSweepChart"), labels, futureEq, realVal);

  renderInflationSweepTable(out.results);
}

/* -----------------------------
   Init
------------------------------ */
async function loadDatasets() {
  // Load market CSV and build monthly
  const spText = await fetchText("./data/sp500.csv");
  const spRows = papaParse(spText);
  SP = buildMonthlyFromDaily(spRows);

  // Load inflation
  const infText = await fetchText("./data/us_inflation.csv");
  const infRows = papaParse(infText);
  INF = loadInflationAnnual(infRows);

  META = {
    firstMonth: SP.meta.firstMonth,
    lastMonth: SP.meta.lastMonth,
    monthlyCount: SP.meta.monthlyCount,
    inflationFirstYear: INF.meta.firstYear,
    inflationLastYear: INF.meta.lastYear,
    inflationOverallAvgPct: INF.meta.overallAvgPct
  };

  document.getElementById("metaBox").textContent =
    `S&P monthly: ${META.monthlyCount.toLocaleString()} | Range: ${META.firstMonth} → ${META.lastMonth} | ` +
    `Inflation: ${META.inflationFirstYear} → ${META.inflationLastYear}`;

  const avgText = `Average inflation across entire dataset: ${META.inflationOverallAvgPct.toFixed(2)}%`;
  document.getElementById("infOverallAvg").textContent = avgText;
  document.getElementById("infOverallAvg2").textContent = avgText;

  // apply min/max + clamp defaults (prevents “immediate error” from placeholders)
  clampMonthInput(document.getElementById("dcaStart"), META.firstMonth, META.lastMonth);
  clampMonthInput(document.getElementById("dcaEnd"), META.firstMonth, META.lastMonth);
  clampMonthInput(document.getElementById("retStart"), META.firstMonth, META.lastMonth);

  const infStart = document.getElementById("infStartYear");
  infStart.min = String(INF.meta.firstYear);
  infStart.max = String(INF.meta.lastYear);
  if (Number(infStart.value) < INF.meta.firstYear) infStart.value = String(INF.meta.firstYear);
  if (Number(infStart.value) > INF.meta.lastYear) infStart.value = String(INF.meta.lastYear);

  validateAll();
}

function wireUp() {
  setupTabs();

  document.getElementById("runDca").addEventListener("click", () => { try { runDca(); } catch (e) { alert(e.message); } });
  document.getElementById("runRet").addEventListener("click", () => { try { runRetirement(); } catch (e) { alert(e.message); } });
  document.getElementById("runSuccess").addEventListener("click", () => { try { runSuccess(); } catch (e) { alert(e.message); } });
  document.getElementById("runInflation").addEventListener("click", () => { try { runInflationCalc(); } catch (e) { alert(e.message); } });
  document.getElementById("runInflationSweep").addEventListener("click", () => { try { runInflationSweepCalc(); } catch (e) { alert(e.message); } });

  ["dcaStart", "dcaEnd"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("input", validateDcaDates);
    el.addEventListener("change", validateDcaDates);
  });

  ["retStart", "retYears"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("input", validateRetirementDates);
    el.addEventListener("change", validateRetirementDates);
  });

  ["infStartYear", "infYears"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("input", validateInflationCalc);
    el.addEventListener("change", validateInflationCalc);
  });

  ["infSweepYears"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("input", validateInflationSweep);
    el.addEventListener("change", validateInflationSweep);
  });

  document.getElementById("retMode").addEventListener("change", toggleRetirementModeUI);
  document.getElementById("sMode").addEventListener("change", toggleSuccessModeUI);

  toggleRetirementModeUI();
  toggleSuccessModeUI();
}

(async function init() {
  wireUp();
  try {
    await loadDatasets();

    // auto-run with the (now clamped) defaults
    if (!document.getElementById("runDca").disabled) runDca();
    if (!document.getElementById("runRet").disabled) runRetirement();
    runSuccess();
    if (!document.getElementById("runInflation").disabled) runInflationCalc();
    if (!document.getElementById("runInflationSweep").disabled) runInflationSweepCalc();
  } catch (e) {
    alert(
      "Failed to load datasets.\n\n" +
      "Make sure you are running via a local server (Live Server / npx serve) or GitHub Pages,\n" +
      "and that your CSVs exist at /docs/data/sp500.csv and /docs/data/us_inflation.csv.\n\n" +
      "Error: " + e.message
    );
    console.error(e);
  }
})();
