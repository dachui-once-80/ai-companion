const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dayPeriod(hour: number): string {
  if (hour < 5) return "凌晨";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 18) return "下午";
  if (hour < 23) return "晚上";
  return "夜里";
}

/** 很晚或一大清早才需要把句子收短。其余钟点只报时段。 */
function quietHours(hour: number): string {
  if (hour >= 23 || hour < 5) return "这个钟点很晚。";
  if (hour < 8) return "这个钟点是一大清早。";
  return "";
}

export function formatLocalClock(date: Date): string {
  const period = dayPeriod(date.getHours());

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 星期${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}（${period}）`;
}

export function formatGap(elapsedMs: number): string {
  const elapsed = Math.max(0, elapsedMs);

  if (elapsed < MINUTE_MS) return "不到一分钟";

  const totalMinutes = Math.floor(elapsed / MINUTE_MS);

  if (totalMinutes < 60) return `${totalMinutes} 分钟`;

  const totalHours = Math.floor(elapsed / HOUR_MS);

  if (totalHours < 24) {
    const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);

    return minutes > 0
      ? `${totalHours} 小时 ${minutes} 分钟`
      : `${totalHours} 小时`;
  }

  const days = Math.floor(elapsed / DAY_MS);
  const hours = Math.floor((elapsed % DAY_MS) / HOUR_MS);

  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

export function describeSessionTime(
  now: Date,
  lastSeenAt: string | null,
): string {
  const quiet = quietHours(now.getHours());
  const nowLine = quiet
    ? `现在是 ${formatLocalClock(now)}。${quiet}`
    : `现在是 ${formatLocalClock(now)}。`;

  return `${nowLine}\n${absenceLine(now, lastSeenAt)}`;
}

function absenceLine(now: Date, lastSeenAt: string | null): string {
  if (!lastSeenAt) return "上次连上的时间没有记下。";

  const parsed = Date.parse(lastSeenAt);

  if (!Number.isFinite(parsed)) return "上次连上的时间没有记下。";

  const gap = formatGap(Math.max(0, now.getTime() - parsed));

  return `上次连上是 ${formatLocalClock(new Date(parsed))}，距现在 ${gap}。`;
}
