function monthToIndex(month) {
  const [yStr, mStr] = String(month).split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return y * 12 + (m - 1);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildReturns(monthly) {
  const closes = monthly.map((m) => Number(m.close));
  const returns = new Array(monthly.length).fill(0);
  for (let i = 1; i < monthly.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (Number.isFinite(prev) && prev > 0 && Number.isFinite(cur)) {
      returns[i] = cur / prev - 1;
    } else {
      returns[i] = 0;
    }
  }
  return returns;
}

function findMonthIndex(monthly, monthStr) {
  const idx = monthly.findIndex((m) => m.month === monthStr);
  if (idx >= 0) return idx;

  const want = monthToIndex(monthStr);
  if (want === null) return -1;
  for (let i = 0; i < monthly.length; i++) {
    const have = monthToIndex(monthly[i].month);
    if (have === want) return i;
  }
  return -1;
}

// Convert annual inflation % to a monthly compounding rate.
// Example: 3% annual -> ~0.2466% per month (compounded).
function monthlyInflationRateFromAnnualPct(annualPct) {
  const a = (Number.isFinite(annualPct) ? annualPct : 3) / 100;
  if (a < -0.99) return -0.99;
  return Math.pow(1 + a, 1 / 12) - 1;
}

function runDcaMonthly({ monthly, initialLumpSum, monthlyContribution, startMonth, endMonth }) {
  const startIdx = findMonthIndex(monthly, startMonth);
  const endIdx = findMonthIndex(monthly, endMonth);
  if (startIdx < 0) throw new Error(`startMonth not found: ${startMonth}`);
  if (endIdx < 0) throw new Error(`endMonth not found: ${endMonth}`);
  if (startIdx > endIdx) throw new Error(`startMonth must be <= endMonth`);

  const returns = buildReturns(monthly);

  let balance = Number.isFinite(initialLumpSum) ? initialLumpSum : 0;
  let contributed = Number.isFinite(initialLumpSum) ? initialLumpSum : 0;

  const series = [];

  for (let i = startIdx; i <= endIdx; i++) {
    balance *= (1 + returns[i]);

    balance += monthlyContribution;
    contributed += monthlyContribution;

    series.push({
      month: monthly[i].month,
      value: balance
    });
  }

  return {
    startMonth,
    endMonth,
    initialLumpSum: Number.isFinite(initialLumpSum) ? initialLumpSum : 0,
    monthlyContribution,
    contributed,
    endingValue: balance,
    series
  };
}

function computeWithdrawal({
  mode,
  ratePerYear,
  initialBalance,
  balance,
  frequency,
  guardrailsState,
  guardrailsConfig,
  ytdReturnAfterMarket,
  isWithdrawalMonth,

  // Inflation-adjusted spending (based on initial)
  inflationBasePeriodWithdraw,
  inflationFactor
}) {
  if (!isWithdrawalMonth) return { withdrawal: 0, guardrailsRate: guardrailsState?.currentRate ?? null };

  const freq = frequency; // "monthly" | "annual"

  if (mode === "percentOfInitial") {
    const annual = initialBalance * ratePerYear;
    const w = freq === "monthly" ? annual / 12 : annual;
    return { withdrawal: w, guardrailsRate: null };
  }

  // NOTE: We are reusing "percentOfCurrent" as the "inflation-adjusted spending based on initial balance" method.
  // Withdrawal does NOT shrink when the account tanks. It is a planned spending amount, adjusted for inflation.
  if (mode === "percentOfCurrent") {
    const w = inflationBasePeriodWithdraw * inflationFactor;
    return { withdrawal: w, guardrailsRate: null };
  }

  if (mode === "guardrails") {
    const step = guardrailsConfig.step; // absolute rate step (e.g. 0.0025)
    const minRate = guardrailsConfig.minRate;
    const maxRate = guardrailsConfig.maxRate;

    if (Number.isFinite(ytdReturnAfterMarket)) {
      if (ytdReturnAfterMarket > 0.08) {
        guardrailsState.currentRate = clamp(guardrailsState.currentRate + step, minRate, maxRate);
      } else if (ytdReturnAfterMarket < 0.03) {
        guardrailsState.currentRate = clamp(guardrailsState.currentRate - step, minRate, maxRate);
      }
    }

    const annual = balance * guardrailsState.currentRate;
    let w = freq === "monthly" ? annual / 12 : annual;

    if (guardrailsConfig.minDollarFloor > 0) {
      w = Math.max(w, guardrailsConfig.minDollarFloor);
    }

    return { withdrawal: w, guardrailsRate: guardrailsState.currentRate };
  }

  throw new Error(`Unknown withdrawal mode: ${mode}`);
}

function runRetirementMonthly({
  monthly,
  initialBalance,
  startMonth,
  durationYears,
  withdrawMode,
  withdrawValue,
  withdrawFrequency,
  guardrailsMinPct,
  guardrailsMaxPct,
  guardrailsMinDollar,

  // For "percentOfCurrent" mode (inflation-adjusted spending): annual inflation assumption (%)
  percentOfCurrentAnnualInflationPct
}) {
  const startIdx = findMonthIndex(monthly, startMonth);
  if (startIdx < 0) throw new Error(`startMonth not found: ${startMonth}`);

  const endIdxExclusive = startIdx + durationYears * 12;
  if (endIdxExclusive > monthly.length - 1) {
    throw new Error(`Not enough data for ${durationYears} years from ${startMonth}`);
  }

  const returns = buildReturns(monthly);

  let balance = initialBalance;
  let success = true;
  let totalWithdrawn = 0;

  let highestBalance = balance;
  let lowestBalance = balance;

  let peak = balance;
  let maxDrawdown = 0;

  const guardrailsState = { currentRate: null };
  const guardrailsConfig = {
    minRate: 0,
    maxRate: 1,
    step: 0.0025, // 0.25 percentage points
    minDollarFloor: 0
  };

  if (withdrawMode === "guardrails") {
    const startRate = (withdrawValue / 100);
    const minRate = (guardrailsMinPct / 100);
    const maxRate = (guardrailsMaxPct / 100);

    if (!Number.isFinite(startRate) || startRate <= 0) throw new Error("Guardrails starting rate must be > 0");
    if (!Number.isFinite(minRate) || minRate < 0) throw new Error("Guardrails min rate must be >= 0");
    if (!Number.isFinite(maxRate) || maxRate <= 0) throw new Error("Guardrails max rate must be > 0");
    if (minRate > maxRate) throw new Error("Guardrails min rate must be <= max rate");

    guardrailsState.currentRate = clamp(startRate, minRate, maxRate);
    guardrailsConfig.minRate = minRate;
    guardrailsConfig.maxRate = maxRate;
    guardrailsConfig.minDollarFloor = Number.isFinite(guardrailsMinDollar) ? Math.max(0, guardrailsMinDollar) : 0;
  }

  let currentYear = Number(String(monthly[startIdx].month).slice(0, 4));
  let yearStartBalance = balance;

  // For inflation-adjusted spending (based on initial)
  const baseRateDecimal = withdrawValue / 100;
  const annualInflPct = Number.isFinite(percentOfCurrentAnnualInflationPct) ? percentOfCurrentAnnualInflationPct : 3;
  const monthlyInfl = monthlyInflationRateFromAnnualPct(annualInflPct);
  let inflationFactor = 1;

  // Base withdrawal for the period, derived from the INITIAL balance (not current).
  // Monthly uses initial * rate / 12; Annual uses initial * rate.
  const inflationBasePeriodWithdraw =
    withdrawMode === "percentOfCurrent"
      ? (withdrawFrequency === "monthly"
          ? (initialBalance * baseRateDecimal) / 12
          : (initialBalance * baseRateDecimal))
      : 0;

  const series = [];

  for (let i = startIdx; i < endIdxExclusive; i++) {
    const monthStr = monthly[i].month;
    const y = Number(String(monthStr).slice(0, 4));
    const m = Number(String(monthStr).slice(5, 7));

    if (y !== currentYear) {
      currentYear = y;
      yearStartBalance = balance;
    }

    // Market return
    balance *= (1 + returns[i]);

    const ytdReturnAfterMarket =
      yearStartBalance > 0 ? (balance / yearStartBalance - 1) : 0;

    const isWithdrawalMonth =
      withdrawFrequency === "monthly"
        ? true
        : (m === 1);

    let withdrawalRatePerYearDecimal = baseRateDecimal;
    if (!Number.isFinite(withdrawalRatePerYearDecimal) || withdrawalRatePerYearDecimal <= 0) {
      throw new Error("Withdraw rate must be > 0");
    }

    const { withdrawal, guardrailsRate } = computeWithdrawal({
      mode: withdrawMode,
      ratePerYear: withdrawalRatePerYearDecimal,
      initialBalance,
      balance,
      frequency: withdrawFrequency,
      guardrailsState,
      guardrailsConfig,
      ytdReturnAfterMarket,
      isWithdrawalMonth,
      inflationBasePeriodWithdraw,
      inflationFactor
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

    // Apply previous month's inflation to next month's withdrawal target.
    // (We update at end of loop so next month uses this month's inflation.)
    if (withdrawMode === "percentOfCurrent") {
      inflationFactor *= (1 + monthlyInfl);
    }

    if (!success) break;
  }

  return {
    success,
    totalWithdrawn,
    endingValue: balance,
    maxDrawdown,
    highestBalance,
    lowestBalance,
    series
  };
}

function runRetirementSuccessByStartYear({
  monthly,
  initialBalance,
  durationYears,
  withdrawMode,
  withdrawValue,
  withdrawFrequency,
  guardrailsMinPct,
  guardrailsMaxPct,
  guardrailsMinDollar,

  // For "percentOfCurrent" mode (inflation-adjusted spending): annual inflation assumption (%)
  percentOfCurrentAnnualInflationPct
}) {
  const returns = buildReturns(monthly);

  const results = [];
  const endingBalances = [];

  let highestBalanceHit = -Infinity;
  let lowestBalanceHit = Infinity;

  const baseRateDecimal = withdrawValue / 100;
  const annualInflPct = Number.isFinite(percentOfCurrentAnnualInflationPct) ? percentOfCurrentAnnualInflationPct : 3;
  const monthlyInfl = monthlyInflationRateFromAnnualPct(annualInflPct);

  for (let i = 0; i < monthly.length; i++) {
    const monthStr = monthly[i].month;
    const m = Number(String(monthStr).slice(5, 7));
    if (m !== 1) continue;

    const startIdx = i;
    const endIdxExclusive = startIdx + durationYears * 12;
    if (endIdxExclusive > monthly.length - 1) break;

    let balance = initialBalance;
    let success = true;

    let highest = balance;
    let lowest = balance;

    let currentYear = Number(String(monthStr).slice(0, 4));
    let yearStartBalance = balance;

    const guardrailsState = { currentRate: null };
    const guardrailsConfig = {
      minRate: 0,
      maxRate: 1,
      step: 0.0025,
      minDollarFloor: 0
    };

    if (withdrawMode === "guardrails") {
      const startRate = (withdrawValue / 100);
      const minRate = (guardrailsMinPct / 100);
      const maxRate = (guardrailsMaxPct / 100);

      guardrailsState.currentRate = clamp(startRate, minRate, maxRate);
      guardrailsConfig.minRate = minRate;
      guardrailsConfig.maxRate = maxRate;
      guardrailsConfig.minDollarFloor = Number.isFinite(guardrailsMinDollar) ? Math.max(0, guardrailsMinDollar) : 0;
    }

    let inflationFactor = 1;
    const inflationBasePeriodWithdraw =
      withdrawMode === "percentOfCurrent"
        ? (withdrawFrequency === "monthly"
            ? (initialBalance * baseRateDecimal) / 12
            : (initialBalance * baseRateDecimal))
        : 0;

    for (let t = startIdx; t < endIdxExclusive; t++) {
      const ms = monthly[t].month;
      const y = Number(String(ms).slice(0, 4));
      const mon = Number(String(ms).slice(5, 7));

      if (y !== currentYear) {
        currentYear = y;
        yearStartBalance = balance;
      }

      balance *= (1 + returns[t]);

      const ytdReturnAfterMarket =
        yearStartBalance > 0 ? (balance / yearStartBalance - 1) : 0;

      const isWithdrawalMonth =
        withdrawFrequency === "monthly"
          ? true
          : (mon === 1);

      const { withdrawal } = computeWithdrawal({
        mode: withdrawMode,
        ratePerYear: baseRateDecimal,
        initialBalance,
        balance,
        frequency: withdrawFrequency,
        guardrailsState,
        guardrailsConfig,
        ytdReturnAfterMarket,
        isWithdrawalMonth,
        inflationBasePeriodWithdraw,
        inflationFactor
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

    const startYear = Number(String(monthStr).slice(0, 4));
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
  const successes = results.filter((r) => r.passed).length;
  const successRate = total ? successes / total : 0;

  const avgEnd = total ? endingBalances.reduce((a, b) => a + b, 0) / total : null;
  const medEnd = total ? median(endingBalances) : null;

  return {
    summary: {
      totalStartYearsTested: total,
      successes,
      successRate,
      averageEndingBalance: avgEnd,
      medianEndingBalance: medEnd,
      highestBalanceHit: Number.isFinite(highestBalanceHit) ? highestBalanceHit : null,
      lowestBalanceHit: Number.isFinite(lowestBalanceHit) ? lowestBalanceHit : null
    },
    results
  };
}

module.exports = {
  runDcaMonthly,
  runRetirementMonthly,
  runRetirementSuccessByStartYear
};
