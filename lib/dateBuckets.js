// All dates handled in IST (Asia/Kolkata) since both carriers operate in India.

const IST_OFFSET_MIN = 5 * 60 + 30;

function toISTDateOnly(date) {
  // Returns YYYY-MM-DD string for the given Date, shifted to IST.
  const ist = new Date(date.getTime() + IST_OFFSET_MIN * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MIN * 60 * 1000);
}

function daysAgoIST(n) {
  const d = nowIST();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function startOfMonthIST() {
  const d = nowIST();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// Returns { start, end } (inclusive, YYYY-MM-DD strings) for each named view.
function getDateRange(view) {
  const today = daysAgoIST(0);
  switch (view) {
    case "yesterday": {
      const y = daysAgoIST(1);
      return { start: y, end: y };
    }
    case "last_7_days":
      return { start: daysAgoIST(6), end: today };
    case "last_30_days":
      return { start: daysAgoIST(29), end: today };
    case "mtd":
      return { start: startOfMonthIST(), end: today };
    default:
      throw new Error(`Unknown view: ${view}`);
  }
}

// Buckets an array of { date: 'YYYY-MM-DD', amount: number } into a total + daily breakdown.
function aggregateDaily(entries, start, end) {
  const byDay = {};
  let total = 0;
  for (const { date, amount } of entries) {
    if (date < start || date > end) continue;
    byDay[date] = (byDay[date] || 0) + amount;
    total += amount;
  }
  return {
    start,
    end,
    total: Math.round(total * 100) / 100,
    daily: Object.entries(byDay)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, amount]) => ({ date, amount: Math.round(amount * 100) / 100 })),
  };
}

module.exports = { toISTDateOnly, nowIST, daysAgoIST, startOfMonthIST, getDateRange, aggregateDaily };
