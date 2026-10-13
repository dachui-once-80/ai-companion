export type OpenMemoryCategory = "episode" | "impression" | "note";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function isOpenCategory(
  category: string,
): category is OpenMemoryCategory {
  return (
    category === "episode" ||
    category === "impression" ||
    category === "note"
  );
}

export function openKey(
  category: OpenMemoryCategory,
  id: string,
): string {
  return `${category}:${id}`;
}

export function openId(
  category: OpenMemoryCategory,
  key: string,
): string {
  const prefix = `${category}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function contentKey(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, "");
}

export function formatLocalDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatToday(date = new Date()): string {
  return `${formatLocalDate(date)} 星期${WEEKDAYS[date.getDay()]}`;
}

export function normalizeTheme(raw: string): string | null {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/^impression[:：]/, "")
    .replace(/[\s_]+/g, "")
    .replace(/[^\u4e00-\u9fffa-z0-9]/g, "")
    .slice(0, 16);

  return text || null;
}

export function normalizeLabel(raw: string): string | null {
  const text = raw
    .trim()
    .replace(/^note[:：]/, "")
    .replace(/[:：]/g, "")
    .replace(/\s+/g, "")
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "")
    .slice(0, 12);

  return text || null;
}

export function normalizeEpisodeDate(
  raw: string | undefined,
  today: string,
): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || raw > today) {
    return today;
  }

  return raw;
}
