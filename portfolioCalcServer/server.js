const path = require("path");
const express = require("express");
const morgan = require("morgan");

const { loadDailyCsvAndBuildMonthly } = require("./lib/dataLoader");
const { loadInflationAnnualFromCsv } = require("./lib/inflationLoader");
const {
  runDcaMonthly,
  runRetirementMonthly,
  runRetirementSuccessByStartYear
} = require("./lib/simulations");

const PORT = process.env.PORT || 4119;
const DATA_CSV =
  process.env.DATA_CSV || path.join(__dirname, "data", "sp500.csv");

const INFLATION_CSV =
  process.env.INFLATION_CSV || path.join(__dirname, "data", "us_inflation.csv");

function toNumber(val, fallback = null) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function badRequest(res, message, details = {}) {
  return res.status(400).json({ error: message, ...details });
}

function assertInflationMeta(inflation) {
  const f = inflation?.meta?.firstYear;
  const l = inflation?.meta?.lastYear;
  if (!Number.isFinite(f) || !Number.isFinite(l)) {
    throw new Error("Inflation dataset meta is invalid");
  }
  if (f < 1800 || l < 1800 || l < f) {
    throw new Error(
      `Inflation dataset meta looks wrong (firstYear=${f}, lastYear=${l}). Check us_inflation.csv formatting.`
    );
  }
}

function runInflationWindow({ inflation, amount, startYear, durationYears }) {
  assertInflationMeta(inflation);

  const sY = Math.floor(startYear);
  const years = Math.floor(durationYears);

  if (!Number.isFinite(sY)) throw new Error("startYear must be a number");
  if (!Number.isFinite(years) || years <= 0) throw new Error("durationYears must be > 0");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be > 0");

  const eY = sY + years - 1;

  if (sY < inflation.meta.firstYear || eY > inflation.meta.lastYear) {
    throw new Error(
      `Inflation range must be within ${inflation.meta.firstYear}–${inflation.meta.lastYear}. Requested ${sY}–${eY}.`
    );
  }

  let factor = 1;
  const series = [];

  for (let y = sY; y <= eY; y++) {
    const row = inflation.byYear.get(y);
    if (!row) throw new Error(`Missing inflation data for year ${y}`);

    const r = row.avgRatePct / 100;
    const mult = 1 + r;
    if (mult <= 0) throw new Error(`Inflation factor became non-positive at year ${y} (rate=${row.avgRatePct}%)`);

    factor *= mult;

    const futureEquivalent = amount * factor;
    const realValueInStartDollars = amount / factor;

    series.push({
      year: y,
      avgInflationPct: row.avgRatePct,
      cumulativeFactor: factor,
      futureEquivalent,
      realValueInStartDollars
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

function runInflationSweep({ inflation, amount, durationYears }) {
  assertInflationMeta(inflation);

  const years = Math.floor(durationYears);

  if (!Number.isFinite(years) || years <= 0) throw new Error("durationYears must be > 0");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be > 0");

  const first = inflation.meta.firstYear;
  const last = inflation.meta.lastYear;

  const maxStartYear = last - years + 1;
  if (maxStartYear < first) {
    throw new Error(
      `durationYears is too large for inflation dataset. Max duration is ${last - first + 1} years.`
    );
  }

  const results = [];
  for (let startYear = first; startYear <= maxStartYear; startYear++) {
    const endYear = startYear + years - 1;

    let factor = 1;
    let sumInfl = 0;

    for (let y = startYear; y <= endYear; y++) {
      const row = inflation.byYear.get(y);
      if (!row) throw new Error(`Missing inflation data for year ${y}`);

      const r = row.avgRatePct / 100;
      const mult = 1 + r;
      if (mult <= 0) throw new Error(`Inflation factor became non-positive at year ${y} (rate=${row.avgRatePct}%)`);

      factor *= mult;
      sumInfl += row.avgRatePct;
    }

    results.push({
      startYear,
      endYear,
      startAmount: amount,
      endAmount: amount * factor,
      realValueInStartDollars: amount / factor,
      cumulativeFactor: factor,
      avgInflationPct: sumInfl / years
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

function validateGuardrailsInputs({ withdrawValue, guardrailsMinPct, guardrailsMaxPct, guardrailsMinDollar }) {
  const startPct = toNumber(withdrawValue);
  const minPct = toNumber(guardrailsMinPct);
  const maxPct = toNumber(guardrailsMaxPct);
  const minDollar = guardrailsMinDollar === undefined || guardrailsMinDollar === null || guardrailsMinDollar === ""
    ? null
    : toNumber(guardrailsMinDollar);

  if (!startPct || startPct <= 0) throw new Error("Guardrails starting withdraw rate must be > 0");
  if (minPct === null || minPct < 0) throw new Error("Guardrails min % must be >= 0");
  if (maxPct === null || maxPct <= 0) throw new Error("Guardrails max % must be > 0");
  if (minPct > maxPct) throw new Error("Guardrails min % must be <= max %");
  if (startPct < minPct || startPct > maxPct) throw new Error("Guardrails starting % must be within min/max");

  if (minDollar !== null && (!Number.isFinite(minDollar) || minDollar < 0)) {
    throw new Error("Guardrails min dollar floor must be >= 0 (or blank)");
  }

  return { startPct, minPct, maxPct, minDollar: minDollar ?? 0 };
}

// For "percentOfCurrent" mode, we now interpret the "More options" field as
// an ANNUAL inflation assumption (%), default 3%.
// (We accept the old request field name too for backwards compatibility.)
function validateInflationAdjustedOptions({ percentOfCurrentAnnualInflationPct, percentOfCurrentAnnualIncreasePct }) {
  const raw =
    percentOfCurrentAnnualInflationPct !== undefined && percentOfCurrentAnnualInflationPct !== null && percentOfCurrentAnnualInflationPct !== ""
      ? percentOfCurrentAnnualInflationPct
      : percentOfCurrentAnnualIncreasePct; // backwards compat

  const inf = raw === undefined || raw === null || raw === "" ? 3 : toNumber(raw);

  if (inf === null || !Number.isFinite(inf) || inf < -50 || inf > 100) {
    throw new Error("Inflation assumption must be between -50 and 100");
  }

  return { annualInflationPct: inf };
}

(async () => {
  const app = express();
  app.use(morgan("dev"));
  app.use(express.json({ limit: "1mb" }));

  let dataset;
  let inflation;

  try {
    dataset = await loadDailyCsvAndBuildMonthly(DATA_CSV);
  } catch (err) {
    console.error("Failed to load S&P CSV:", err);
    process.exit(1);
  }

  try {
    inflation = loadInflationAnnualFromCsv(INFLATION_CSV);
    assertInflationMeta(inflation);
  } catch (err) {
    console.error("Failed to load Inflation CSV:", err);
    process.exit(1);
  }

  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/meta", (req, res) => {
    const {
      dailyCount,
      monthlyCount,
      firstDailyDate,
      lastDailyDate,
      firstMonth,
      lastMonth
    } = dataset.meta;

    res.json({
      dailyCount,
      monthlyCount,
      firstDailyDate,
      lastDailyDate,
      firstMonth,
      lastMonth,
      inflation: {
        yearCount: inflation.meta.yearCount,
        firstYear: inflation.meta.firstYear,
        lastYear: inflation.meta.lastYear,
        overallAvgRatePct: inflation.meta.overallAvgRatePct
      }
    });
  });

  app.post("/api/sim/inflation", (req, res) => {
    const amount = toNumber(req.body.amount);
    const startYear = toNumber(req.body.startYear);
    const durationYears = toNumber(req.body.durationYears);

    try {
      const out = runInflationWindow({
        inflation,
        amount,
        startYear,
        durationYears
      });
      res.json(out);
    } catch (e) {
      return badRequest(res, e.message);
    }
  });

  app.post("/api/analysis/inflation-sweep", (req, res) => {
    const amount = toNumber(req.body.amount);
    const durationYears = toNumber(req.body.durationYears);

    try {
      const out = runInflationSweep({ inflation, amount, durationYears });
      res.json(out);
    } catch (e) {
      return badRequest(res, e.message);
    }
  });

  app.post("/api/sim/dca", (req, res) => {
    const initialLumpSum = toNumber(req.body.initialLumpSum, 0);
    const monthlyContribution = toNumber(req.body.monthlyContribution);
    const startMonth = req.body.startMonth;
    const endMonth = req.body.endMonth;

    if (initialLumpSum === null || initialLumpSum < 0) {
      return badRequest(res, "initialLumpSum must be >= 0");
    }
    if (!monthlyContribution || monthlyContribution <= 0) {
      return badRequest(res, "monthlyContribution must be > 0");
    }
    if (!startMonth || !endMonth) {
      return badRequest(res, "startMonth and endMonth are required (YYYY-MM)");
    }

    try {
      const out = runDcaMonthly({
        monthly: dataset.monthly,
        initialLumpSum,
        monthlyContribution,
        startMonth,
        endMonth
      });
      res.json(out);
    } catch (e) {
      return badRequest(res, e.message);
    }
  });

  app.post("/api/sim/retirement", (req, res) => {
    const initialBalance = toNumber(req.body.initialBalance);
    const startMonth = req.body.startMonth;
    const durationYears = Math.floor(toNumber(req.body.durationYears));
    const withdrawMode = req.body.withdrawMode || "percentOfInitial";
    const withdrawValue = toNumber(req.body.withdrawValue);
    const withdrawFrequency = req.body.withdrawFrequency || "monthly";

    if (!initialBalance || initialBalance <= 0) {
      return badRequest(res, "initialBalance must be > 0");
    }
    if (!startMonth) {
      return badRequest(res, "startMonth is required (YYYY-MM)");
    }
    if (!durationYears || durationYears <= 0) {
      return badRequest(res, "durationYears must be > 0");
    }
    if (!withdrawValue || withdrawValue <= 0) {
      return badRequest(res, "withdrawValue must be > 0");
    }
    if (!["percentOfInitial", "percentOfCurrent", "guardrails"].includes(withdrawMode)) {
      return badRequest(
        res,
        "withdrawMode must be one of percentOfInitial, percentOfCurrent, guardrails"
      );
    }
    if (!["monthly", "annual"].includes(withdrawFrequency)) {
      return badRequest(res, "withdrawFrequency must be monthly or annual");
    }

    let guardrails = null;
    if (withdrawMode === "guardrails") {
      try {
        guardrails = validateGuardrailsInputs({
          withdrawValue,
          guardrailsMinPct: req.body.guardrailsMinPct,
          guardrailsMaxPct: req.body.guardrailsMaxPct,
          guardrailsMinDollar: req.body.guardrailsMinDollar
        });
      } catch (e) {
        return badRequest(res, e.message);
      }
    }

    let inflationOpt = { annualInflationPct: 3 };
    if (withdrawMode === "percentOfCurrent") {
      try {
        inflationOpt = validateInflationAdjustedOptions({
          percentOfCurrentAnnualInflationPct: req.body.percentOfCurrentAnnualInflationPct,
          percentOfCurrentAnnualIncreasePct: req.body.percentOfCurrentAnnualIncreasePct // backward compat
        });
      } catch (e) {
        return badRequest(res, e.message);
      }
    }

    try {
      const out = runRetirementMonthly({
        monthly: dataset.monthly,
        initialBalance,
        startMonth,
        durationYears,
        withdrawMode,
        withdrawValue,
        withdrawFrequency,
        guardrailsMinPct: guardrails?.minPct,
        guardrailsMaxPct: guardrails?.maxPct,
        guardrailsMinDollar: guardrails?.minDollar,
        percentOfCurrentAnnualInflationPct: inflationOpt.annualInflationPct
      });
      res.json(out);
    } catch (e) {
      return badRequest(res, e.message);
    }
  });

  app.post("/api/analysis/retirement-success", (req, res) => {
    const initialBalance = toNumber(req.body.initialBalance);
    const durationYears = Math.floor(toNumber(req.body.durationYears));
    const withdrawMode = req.body.withdrawMode || "percentOfInitial";
    const withdrawValue = toNumber(req.body.withdrawValue);
    const withdrawFrequency = req.body.withdrawFrequency || "monthly";

    if (!initialBalance || initialBalance <= 0) {
      return badRequest(res, "initialBalance must be > 0");
    }
    if (!durationYears || durationYears <= 0) {
      return badRequest(res, "durationYears must be > 0");
    }
    if (!withdrawValue || withdrawValue <= 0) {
      return badRequest(res, "withdrawValue must be > 0");
    }
    if (!["percentOfInitial", "percentOfCurrent", "guardrails"].includes(withdrawMode)) {
      return badRequest(
        res,
        "withdrawMode must be one of percentOfInitial, percentOfCurrent, guardrails"
      );
    }
    if (!["monthly", "annual"].includes(withdrawFrequency)) {
      return badRequest(res, "withdrawFrequency must be monthly or annual");
    }

    let guardrails = null;
    if (withdrawMode === "guardrails") {
      try {
        guardrails = validateGuardrailsInputs({
          withdrawValue,
          guardrailsMinPct: req.body.guardrailsMinPct,
          guardrailsMaxPct: req.body.guardrailsMaxPct,
          guardrailsMinDollar: req.body.guardrailsMinDollar
        });
      } catch (e) {
        return badRequest(res, e.message);
      }
    }

    let inflationOpt = { annualInflationPct: 3 };
    if (withdrawMode === "percentOfCurrent") {
      try {
        inflationOpt = validateInflationAdjustedOptions({
          percentOfCurrentAnnualInflationPct: req.body.percentOfCurrentAnnualInflationPct,
          percentOfCurrentAnnualIncreasePct: req.body.percentOfCurrentAnnualIncreasePct // backward compat
        });
      } catch (e) {
        return badRequest(res, e.message);
      }
    }

    try {
      const out = runRetirementSuccessByStartYear({
        monthly: dataset.monthly,
        initialBalance,
        durationYears,
        withdrawMode,
        withdrawValue,
        withdrawFrequency,
        guardrailsMinPct: guardrails?.minPct,
        guardrailsMaxPct: guardrails?.maxPct,
        guardrailsMinDollar: guardrails?.minDollar,
        percentOfCurrentAnnualInflationPct: inflationOpt.annualInflationPct
      });
      res.json(out);
    } catch (e) {
      return badRequest(res, e.message);
    }
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Loaded S&P CSV: ${DATA_CSV}`);
    console.log(`Loaded Inflation CSV: ${INFLATION_CSV}`);
    console.log(
      `Inflation years: ${inflation.meta.firstYear} → ${inflation.meta.lastYear} (${inflation.meta.yearCount}) | overall avg=${inflation.meta.overallAvgRatePct.toFixed(2)}%`
    );
  });
})();
