let dcaChart;
let retChart;
let successChart;
let infChart;
let infSweepChart;

let META = null;

function money(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  });
}

function pct(n) {
  if (!Number.isFinite(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}

function num(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function pctNum(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2) + "%";
}

async function api(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error || "Request failed");
  }
  return json;
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

function monthToIndex(month) {
  if (!month || typeof month !== "string") return null;
  const [yStr, mStr] = month.split("-");
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

async function loadMeta() {
  const res = await fetch("/api/meta");
  const meta = await res.json();
  META = meta;

  const el = document.getElementById("metaBox");
  el.textContent =
    `S&P Monthly: ${meta.monthlyCount.toLocaleString()} | ` +
    `S&P Daily: ${meta.dailyCount.toLocaleString()} | ` +
    `S&P Range: ${meta.firstMonth} → ${meta.lastMonth} | ` +
    `Inflation Range: ${meta.inflation.firstYear} → ${meta.inflation.lastYear}`;

  // Apply native min/max restrictions
  const dcaStart = document.getElementById("dcaStart");
  const dcaEnd = document.getElementById("dcaEnd");
  const retStart = document.getElementById("retStart");

  [dcaStart, dcaEnd, retStart].forEach((inp) => {
    if (!inp) return;
    inp.min = meta.firstMonth;
    inp.max = meta.lastMonth;
  });

  const infStartYear = document.getElementById("infStartYear");
  if (infStartYear) {
    infStartYear.min = String(meta.inflation.firstYear);
    infStartYear.max = String(meta.inflation.lastYear);
  }

  const overall = meta.inflation.overallAvgRatePct;
  const txt = Number.isFinite(overall)
    ? `Average inflation across entire dataset: ${overall.toFixed(2)}%`
    : "";
  const avg1 = document.getElementById("infOverallAvg");
  const avg2 = document.getElementById("infOverallAvg2");
  if (avg1) avg1.textContent = txt;
  if (avg2) avg2.textContent = txt;

  validateAll();
}

function makeLineChart(canvas, labels, datasets, yTitle = "Value ($)") {
  return new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "rgba(255,255,255,0.80)" } },
        tooltip: { enabled: true }
      },
      scales: {
        x: {
          ticks: { color: "rgba(255,255,255,0.65)", maxTicksLimit: 10 },
          grid: { color: "rgba(255,255,255,0.08)" }
        },
        y: {
          ticks: { color: "rgba(255,255,255,0.65)" },
          grid: { color: "rgba(255,255,255,0.08)" },
          title: { display: true, text: yTitle, color: "rgba(255,255,255,0.70)" }
        }
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
      plugins: {
        legend: { labels: { color: "rgba(255,255,255,0.80)" } }
      },
      scales: {
        x: {
          ticks: { color: "rgba(255,255,255,0.65)", maxTicksLimit: 14 },
          grid: { color: "rgba(255,255,255,0.08)" }
        },
        y: {
          ticks: { color: "rgba(255,255,255,0.65)" },
          grid: { color: "rgba(255,255,255,0.08)" },
          title: { display: true, text: yTitle, color: "rgba(255,255,255,0.70)" }
        }
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
      plugins: {
        legend: { labels: { color: "rgba(255,255,255,0.80)" } }
      },
      scales: {
        x: {
          ticks: { color: "rgba(255,255,255,0.65)", maxTicksLimit: 14 },
          grid: { color: "rgba(255,255,255,0.08)" }
        },
        y: {
          ticks: { color: "rgba(255,255,255,0.65)" },
          grid: { color: "rgba(255,255,255,0.08)" },
          title: { display: true, text: "Dollars ($)", color: "rgba(255,255,255,0.70)" }
        }
      }
    }
  });
}

/* ---------------------------
   Quick validation (client)
---------------------------- */
function validateDcaDates() {
  if (!META) return;

  const start = document.getElementById("dcaStart").value;
  const end = document.getElementById("dcaEnd").value;
  const hintEl = document.getElementById("dcaDateHint");
  const btn = document.getElementById("runDca");

  const min = META.firstMonth;
  const max = META.lastMonth;

  let msg = "";
  if (!start || !end) msg = "Choose both a start month and end month.";
  else if (start < min || start > max || end < min || end > max) msg = `Dates must be within ${min} → ${max}.`;
  else if (start > end) msg = "Start month must be before (or equal to) end month.";

  setHint(hintEl, msg, Boolean(msg));
  setDisabled(btn, Boolean(msg));
}

function validateRetirementDates() {
  if (!META) return;

  const start = document.getElementById("retStart").value;
  const years = Number(document.getElementById("retYears").value);
  const hintEl = document.getElementById("retDateHint");
  const btn = document.getElementById("runRet");

  const min = META.firstMonth;
  const max = META.lastMonth;

  let msg = "";
  if (!start) msg = "Choose a start month.";
  else if (start < min || start > max) msg = `Start month must be within ${min} → ${max}.`;
  else if (!Number.isFinite(years) || years <= 0) msg = "Duration must be > 0 years.";
  else {
    const startIdx = monthToIndex(start);
    const lastIdx = monthToIndex(max);
    if (startIdx === null || lastIdx === null) msg = "Invalid month format.";
    else {
      const endIdxNeeded = startIdx + years * 12;
      if (endIdxNeeded > lastIdx) {
        msg = `Not enough S&P data for ${years} years from ${start}. Try an earlier start month.`;
      }
    }
  }

  setHint(hintEl, msg, Boolean(msg));
  setDisabled(btn, Boolean(msg));
}

function validateInflationCalc() {
  if (!META) return;

  const startYear = Number(document.getElementById("infStartYear").value);
  const years = Number(document.getElementById("infYears").value);
  const hintEl = document.getElementById("infHint");
  const btn = document.getElementById("runInflation");

  const minY = META.inflation.firstYear;
  const maxY = META.inflation.lastYear;

  let msg = "";
  if (!Number.isFinite(startYear)) msg = "Start year is required.";
  else if (startYear < minY || startYear > maxY) msg = `Start year must be within ${minY} → ${maxY}.`;
  else if (!Number.isFinite(years) || years <= 0) msg = "Duration must be > 0 years.";
  else {
    const endYear = startYear + years - 1;
    if (endYear > maxY) msg = `That window ends at ${endYear}, but inflation data ends at ${maxY}.`;
  }

  setHint(hintEl, msg, Boolean(msg));
  setDisabled(btn, Boolean(msg));
}

function validateInflationSweep() {
  if (!META) return;

  const years = Number(document.getElementById("infSweepYears").value);
  const hintEl = document.getElementById("infSweepHint");
  const btn = document.getElementById("runInflationSweep");

  const minY = META.inflation.firstYear;
  const maxY = META.inflation.lastYear;
  const maxDuration = (maxY - minY + 1);

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

/* ---------------------------
   Mode UI toggles
---------------------------- */
function toggleRetirementModeUI() {
  const mode = document.getElementById("retMode").value;
  const std = document.getElementById("retStandardBox");
  const gr = document.getElementById("retGuardrailsBox");
  const more = document.getElementById("retMore");
  const pocOpts = document.getElementById("retPercentCurrentOptions");

  if (mode === "guardrails") {
    std.style.display = "none";
    gr.style.display = "grid";
  } else {
    std.style.display = "grid";
    gr.style.display = "none";
  }

  // More options should only exist for inflation-adjusted method
  if (more) more.style.display = (mode === "percentOfCurrent") ? "block" : "none";
  if (pocOpts) pocOpts.style.display = (mode === "percentOfCurrent") ? "grid" : "none";
}

function toggleSuccessModeUI() {
  const mode = document.getElementById("sMode").value;
  const std = document.getElementById("sStandardBox");
  const gr = document.getElementById("sGuardrailsBox");
  const more = document.getElementById("sMore");
  const pocOpts = document.getElementById("sPercentCurrentOptions");

  if (mode === "guardrails") {
    std.style.display = "none";
    gr.style.display = "grid";
  } else {
    std.style.display = "grid";
    gr.style.display = "none";
  }

  if (more) more.style.display = (mode === "percentOfCurrent") ? "block" : "none";
  if (pocOpts) pocOpts.style.display = (mode === "percentOfCurrent") ? "grid" : "none";
}

/* ---------------------------
   Sims
---------------------------- */
async function runDca() {
  const initialLumpSum = Number(document.getElementById("dcaLumpSum").value);
  const monthlyContribution = Number(document.getElementById("dcaMonthly").value);
  const startMonth = document.getElementById("dcaStart").value;
  const endMonth = document.getElementById("dcaEnd").value;

  const out = await api("/api/sim/dca", {
    initialLumpSum,
    monthlyContribution,
    startMonth,
    endMonth
  });

  const stats = document.getElementById("dcaStats");
  setStats(stats, [
    { label: "Initial lump sum", value: money(out.initialLumpSum) },
    { label: "Total contributed", value: money(out.contributed) },
    { label: "Ending value", value: money(out.endingValue) },
    {
      label: "Multiple on contributions",
      value: (out.contributed > 0 ? (out.endingValue / out.contributed).toFixed(2) + "×" : "—")
    }
  ]);

  const labels = out.series.map((p) => p.month);
  const values = out.series.map((p) => p.value);

  if (dcaChart) dcaChart.destroy();
  dcaChart = makeLineChart(
    document.getElementById("dcaChart"),
    labels,
    [{ label: "Portfolio value", data: values, tension: 0.2, pointRadius: 0 }],
    "Portfolio value ($)"
  );
}

async function runRetirement() {
  const initialBalance = Number(document.getElementById("retInitial").value);
  const startMonth = document.getElementById("retStart").value;
  const durationYears = Number(document.getElementById("retYears").value);
  const withdrawMode = document.getElementById("retMode").value;
  const withdrawFrequency = document.getElementById("retFreq").value;

  let withdrawValue;
  let guardrailsMinPct;
  let guardrailsMaxPct;
  let guardrailsMinDollar;

  let percentOfCurrentAnnualInflationPct;

  if (withdrawMode === "guardrails") {
    withdrawValue = Number(document.getElementById("retGStartPct").value);
    guardrailsMinPct = Number(document.getElementById("retGMinPct").value);
    guardrailsMaxPct = Number(document.getElementById("retGMaxPct").value);
    const rawFloor = document.getElementById("retGMinDollar").value;
    guardrailsMinDollar = rawFloor === "" ? "" : Number(rawFloor);
  } else {
    withdrawValue = Number(document.getElementById("retWithdrawValue").value);

    if (withdrawMode === "percentOfCurrent") {
      const infRaw = document.getElementById("retPctCurrentIncrease").value;
      percentOfCurrentAnnualInflationPct = infRaw === "" ? 3 : Number(infRaw);
    }
  }

  const out = await api("/api/sim/retirement", {
    initialBalance,
    startMonth,
    durationYears,
    withdrawMode,
    withdrawValue,
    withdrawFrequency,
    guardrailsMinPct,
    guardrailsMaxPct,
    guardrailsMinDollar,
    percentOfCurrentAnnualInflationPct
  });

  const stats = document.getElementById("retStats");
  setStats(stats, [
    { label: "Success (never hit $0)", value: out.success ? "Yes" : "No" },
    { label: "Total withdrawn", value: money(out.totalWithdrawn) },
    { label: "Ending value", value: money(out.endingValue) },
    { label: "Max drawdown", value: pct(out.maxDrawdown) }
  ]);

  const labels = out.series.map((p) => p.month);
  const values = out.series.map((p) => p.value);
  const withdrawals = out.series.map((p) => p.withdrawal);

  if (retChart) retChart.destroy();
  retChart = makeLineChart(
    document.getElementById("retChart"),
    labels,
    [
      { label: "Portfolio value", data: values, tension: 0.2, pointRadius: 0 },
      { label: "Withdrawal (period)", data: withdrawals, tension: 0.2, pointRadius: 0 }
    ],
    "Dollars ($)"
  );
}

function renderSuccessTable(results) {
  const table = document.getElementById("successTable");
  const tbody = table.querySelector("tbody");
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
    tr.innerHTML = `<td colspan="6" class="muted-cell">No results for this configuration.</td>`;
    tbody.appendChild(tr);
  }
}

async function runSuccess() {
  const initialBalance = Number(document.getElementById("sInitial").value);
  const durationYears = Number(document.getElementById("sYears").value);
  const withdrawMode = document.getElementById("sMode").value;
  const withdrawFrequency = document.getElementById("sFreq").value;

  let withdrawValue;
  let guardrailsMinPct;
  let guardrailsMaxPct;
  let guardrailsMinDollar;

  let percentOfCurrentAnnualInflationPct;

  if (withdrawMode === "guardrails") {
    withdrawValue = Number(document.getElementById("sGStartPct").value);
    guardrailsMinPct = Number(document.getElementById("sGMinPct").value);
    guardrailsMaxPct = Number(document.getElementById("sGMaxPct").value);
    const rawFloor = document.getElementById("sGMinDollar").value;
    guardrailsMinDollar = rawFloor === "" ? "" : Number(rawFloor);
  } else {
    withdrawValue = Number(document.getElementById("sWithdrawValue").value);

    if (withdrawMode === "percentOfCurrent") {
      const infRaw = document.getElementById("sPctCurrentIncrease").value;
      percentOfCurrentAnnualInflationPct = infRaw === "" ? 3 : Number(infRaw);
    }
  }

  const out = await api("/api/analysis/retirement-success", {
    initialBalance,
    durationYears,
    withdrawMode,
    withdrawValue,
    withdrawFrequency,
    guardrailsMinPct,
    guardrailsMaxPct,
    guardrailsMinDollar,
    percentOfCurrentAnnualInflationPct
  });

  const s = out.summary;

  const stats = document.getElementById("successStats");
  setStats(stats, [
    { label: "Start years tested", value: s.totalStartYearsTested.toLocaleString() },
    { label: "Successes", value: s.successes.toLocaleString() },
    { label: "Success rate", value: pct(s.successRate) },
    { label: "Average ending balance", value: money(s.averageEndingBalance) },
    { label: "Median ending balance", value: money(s.medianEndingBalance) },
    { label: "Highest balance hit (any run)", value: money(s.highestBalanceHit) },
    { label: "Lowest balance hit (any run)", value: money(s.lowestBalanceHit) }
  ]);

  const labels = out.results.map((r) => String(r.startYear));
  const passedEnding = out.results.map((r) => (r.passed ? r.endingBalance : null));
  const failedEnding = out.results.map((r) => (!r.passed ? r.endingBalance : null));

  if (successChart) successChart.destroy();
  successChart = makeBarChart(
    document.getElementById("successChart"),
    labels,
    [
      { label: "Ending balance (passed)", data: passedEnding },
      { label: "Ending balance (failed)", data: failedEnding }
    ],
    "Ending balance ($)"
  );

  renderSuccessTable(out.results);
}

/* ---------------------------
   Inflation
---------------------------- */
async function runInflation() {
  const amount = Number(document.getElementById("infAmount").value);
  const startYear = Number(document.getElementById("infStartYear").value);
  const durationYears = Number(document.getElementById("infYears").value);

  const out = await api("/api/sim/inflation", { amount, startYear, durationYears });

  const stats = document.getElementById("infStats");
  setStats(stats, [
    { label: "Period", value: `${out.startYear} → ${out.endYear} (${out.durationYears} yrs)` },
    { label: "Cumulative inflation factor", value: num(out.cumulativeInflationFactor) + "×" },
    { label: "Future equivalent (same buying power)", value: money(out.futureEquivalentSameBuyingPower) },
    { label: "Real value (in start-year dollars)", value: money(out.purchasingPowerInStartDollars) }
  ]);

  const labels = out.series.map((p) => String(p.year));
  const futureEq = out.series.map((p) => p.futureEquivalent);
  const realVal = out.series.map((p) => p.realValueInStartDollars);

  if (infChart) infChart.destroy();
  infChart = makeLineChart(
    document.getElementById("infChart"),
    labels,
    [
      { label: "Future equivalent (same buying power)", data: futureEq, tension: 0.2, pointRadius: 0 },
      { label: "Real value (in start-year dollars)", data: realVal, tension: 0.2, pointRadius: 0 }
    ],
    "Dollars ($)"
  );
}

function renderInflationSweepTable(results) {
  const table = document.getElementById("infSweepTable");
  const tbody = table.querySelector("tbody");
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

  if (!results.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="muted-cell">No results.</td>`;
    tbody.appendChild(tr);
  }
}

async function runInflationSweep() {
  const amount = Number(document.getElementById("infSweepAmount").value);
  const durationYears = Number(document.getElementById("infSweepYears").value);

  const out = await api("/api/analysis/inflation-sweep", { amount, durationYears });

  const stats = document.getElementById("infSweepStats");
  setStats(stats, [
    { label: "Start years tested", value: out.summary.startYearsTested.toLocaleString() },
    { label: "Start-year range", value: `${out.summary.firstStartYear} → ${out.summary.lastStartYear}` },
    { label: "Window length", value: `${out.durationYears} years (inclusive)` }
  ]);

  const labels = out.results.map((r) => String(r.startYear));
  const futureEq = out.results.map((r) => r.endAmount);
  const realVal = out.results.map((r) => r.realValueInStartDollars);

  if (infSweepChart) infSweepChart.destroy();
  infSweepChart = makeInflationSweepChart(
    document.getElementById("infSweepChart"),
    labels,
    futureEq,
    realVal
  );

  renderInflationSweepTable(out.results);
}

/* ---------------------------
   Wiring
---------------------------- */
function wireUp() {
  setupTabs();

  document.getElementById("runDca").addEventListener("click", async () => {
    try { await runDca(); } catch (e) { alert(e.message); }
  });

  document.getElementById("runRet").addEventListener("click", async () => {
    try { await runRetirement(); } catch (e) { alert(e.message); }
  });

  document.getElementById("runSuccess").addEventListener("click", async () => {
    try { await runSuccess(); } catch (e) { alert(e.message); }
  });

  document.getElementById("runInflation").addEventListener("click", async () => {
    try { await runInflation(); } catch (e) { alert(e.message); }
  });

  document.getElementById("runInflationSweep").addEventListener("click", async () => {
    try { await runInflationSweep(); } catch (e) { alert(e.message); }
  });

  // Validation hooks
  ["dcaStart", "dcaEnd"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", validateDcaDates);
    el?.addEventListener("change", validateDcaDates);
  });

  ["retStart", "retYears"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", validateRetirementDates);
    el?.addEventListener("change", validateRetirementDates);
  });

  ["infStartYear", "infYears"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", validateInflationCalc);
    el?.addEventListener("change", validateInflationCalc);
  });

  ["infSweepYears"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", validateInflationSweep);
    el?.addEventListener("change", validateInflationSweep);
  });

  // Mode toggles
  document.getElementById("retMode").addEventListener("change", toggleRetirementModeUI);
  document.getElementById("sMode").addEventListener("change", toggleSuccessModeUI);

  // Initialize mode UI
  toggleRetirementModeUI();
  toggleSuccessModeUI();
}

(async function init() {
  wireUp();
  await loadMeta();

  validateAll();

  try { if (!document.getElementById("runDca").disabled) await runDca(); } catch {}
  try { if (!document.getElementById("runRet").disabled) await runRetirement(); } catch {}
  try { await runSuccess(); } catch {}
  try { if (!document.getElementById("runInflation").disabled) await runInflation(); } catch {}
  try { if (!document.getElementById("runInflationSweep").disabled) await runInflationSweep(); } catch {}
})();
