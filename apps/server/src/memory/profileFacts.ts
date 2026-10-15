/**
 * 会反复改变陪伴方式的档案。
 * 在意的日子写成以后能直接读出的日期，主动开口时再用。
 */

export type ReadableDate = {
  /** `YYYY-MM-DD`，或用户没说年份时的 `MM-DD`。每年重复时 date 是 `MM-DD`。 */
  date: string;
  yearly: boolean;
  label: string;
};

const YEARLY = /^每年 (\d{2})-(\d{2}) (.+)$/;
const ONCE = /^(\d{4}-\d{2}-\d{2}) (.+)$/;
const MONTH_DAY = /^(\d{2}-\d{2}) (.+)$/;

/** 假设、玩笑、转述别人的，不能进档案。 */
export function isUnstatedProfile(content: string): boolean {
  const text = content.replace(/\s+/g, "");

  if (/开玩笑|逗你的|当我没说|说说而已|说着玩/.test(text)) return true;
  if (/如果|假如|万一|假设|要是|倘若/.test(text)) return true;
  if (/听说|据说|转述|听别人说/.test(text)) return true;
  if (
    /(?:朋友|同事|同学|别人|他人|我妈|我爸|家人|他说|她说).{0,8}(?:难过|伤心|难受|心情不好|不想被|别提|别给建议|先别)/.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * 用户明确说自己难过时想被听还是想要办法。
 * 对不上这几句就不写，避免把没说出口的收成档案。
 */
export function explicitWhenSad(text: string): string | null {
  const compact = text.replace(/\s+/g, "");

  if (isUnstatedProfile(compact)) return null;
  if (
    /(?:朋友|同事|同学|别人|他人|他说|她说|我妈|我爸).{0,8}(?:难过|伤心|难受|心情不好)/.test(
      compact,
    )
  ) {
    return null;
  }

  const aboutSelf =
    /我(?:自己)?(?:现在|今天)?(?:很|特别|有点|比较|真|挺)?(?:难过|伤心|难受|心情不好)/.test(
      compact,
    );

  if (!aboutSelf) return null;

  if (
    /先别给建议|别给建议|不要给建议|不要建议|别出主意|先别出主意|别给办法|不要给办法|先别给办法/.test(
      compact,
    )
  ) {
    return "难过时先别给建议";
  }

  if (/想被听|先听我说|先听着|听完再说|先听完/.test(compact)) {
    return "难过时想先被听";
  }

  if (/想要办法|给我办法|想听建议|给我建议/.test(compact)) {
    return "难过时想要办法";
  }

  return null;
}

/** 这是难过时的陪伴偏好，不要再塞进「我们之间」的先听完或先别建议。 */
export function describesWhenSad(text: string): boolean {
  const compact = text.replace(/\s+/g, "");

  if (!/(?:难过|伤心|难受|心情不好)/.test(compact)) return false;

  return /建议|被听|听我说|听着|办法/.test(compact);
}

export function parseImportantDate(content: string): ReadableDate | null {
  const text = content.trim().replace(/\s+/g, " ");
  const yearly = text.match(YEARLY);

  if (yearly) {
    const date = `${yearly[1]}-${yearly[2]}`;

    if (!validMonthDay(yearly[1], yearly[2])) return null;

    return { date, yearly: true, label: yearly[3].trim() };
  }

  const once = text.match(ONCE);

  if (once) {
    const [year, month, day] = once[1].split("-");

    if (!year || !month || !day || !isoDate(year, month, day)) return null;

    return { date: once[1], yearly: false, label: once[2].trim() };
  }

  const monthDay = text.match(MONTH_DAY);

  if (!monthDay || !validMonthDay(monthDay[1], monthDay[2])) return null;

  return {
    date: `${monthDay[1]}-${monthDay[2]}`,
    yearly: false,
    label: monthDay[3].trim(),
  };
}

export function formatImportantDate(value: ReadableDate): string {
  if (value.yearly) return `每年 ${value.date} ${value.label}`;

  return `${value.date} ${value.label}`;
}

/**
 * 收成固定写法，方便以后按日期读。
 * 用户没说年份就不补年份。读不出日期就返回 null，调用方不要存。
 */
export function normalizeImportantDate(content: string): string | null {
  const trimmed = content.trim().replace(/\s+/g, " ");

  if (!trimmed || isUnstatedProfile(trimmed)) return null;

  const parsed = parseImportantDate(trimmed);

  if (parsed) return formatImportantDate(parsed);

  const compact = trimmed.replace(/\s+/g, "");
  const yearly = compact.match(/每年(\d{1,2})月(\d{1,2})[日号]?/);

  if (yearly) {
    const date = monthDay(yearly[1], yearly[2]);
    const label = labelWithout(compact, yearly[0]);

    if (!date || !label) return null;

    return `每年 ${date} ${label}`;
  }

  const full = compact.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/);

  if (full) {
    const date = isoDate(full[1] ?? "", full[2] ?? "", full[3] ?? "");
    const label = labelWithout(compact, full[0]);

    if (!date || !label) return null;

    return `${date} ${label}`;
  }

  const isoIn = trimmed.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (isoIn) {
    const date = isoDate(isoIn[1] ?? "", isoIn[2] ?? "", isoIn[3] ?? "");
    const label = labelWithout(compact, isoIn[0].replace(/\s+/g, ""));

    if (!date || !label) return null;

    return `${date} ${label}`;
  }

  const onlyMonthDay = compact.match(/(\d{1,2})月(\d{1,2})[日号]/);

  if (onlyMonthDay && !/每年/.test(compact) && !/\d{4}年/.test(compact)) {
    const date = monthDay(onlyMonthDay[1], onlyMonthDay[2]);
    const label = labelWithout(compact, onlyMonthDay[0]);

    if (!date || !label) return null;

    return `${date} ${label}`;
  }

  return null;
}

function labelWithout(compact: string, dateChunk: string): string | null {
  const label = compact
    .replace(dateChunk, "")
    .replace(/^(?:是|在|有|的|为)+/, "")
    .replace(/(?:是|在|的)+$/, "")
    .replace(/[，。、：:；;！!？?\s]/g, "")
    .slice(0, 40);

  if (label.length < 2) return null;

  return label;
}

function monthDay(month: string | undefined, day: string | undefined): string | null {
  if (!month || !day || !validMonthDay(month, day)) return null;

  return `${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function isoDate(year: string, month: string, day: string): string | null {
  const y = Number(year);

  if (!Number.isInteger(y) || y < 1900 || y > 2100) return null;
  if (!validMonthDay(month, day, y)) return null;

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function validMonthDay(
  month: string | undefined,
  day: string | undefined,
  year = 2024,
): boolean {
  const m = Number(month);
  const d = Number(day);

  if (!Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;

  const date = new Date(Date.UTC(year, m - 1, d));

  return date.getUTCFullYear() === year && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
