/**
 * 时区工具：在"账本时区的墙上时间"与"带时区偏移的 ISO 时间"之间转换
 *
 * 为什么需要：用户在表单里填的是"9 月 24 日 12:30"这样的墙上时间，它的含义取决于时区；
 * 接口要求带偏移的 ISO 时间（docs/api.md"流水 / 金额与时间"），展示时又要按账本时区还原。
 * 这里只依赖标准的 Intl API，前后端都可用；支持有夏令时的时区。
 */

/** 墙上时间的各个部分 */
interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    // 使用 en-US + h23，保证输出的数字格式固定，不受运行环境语言影响
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** 某个时刻在指定时区的墙上时间 */
function wallPartsAt(instant: Date, timeZone: string): WallParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** 指定时刻该时区相对 UTC 的偏移（分钟，东八区为 +480） */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const w = wallPartsAt(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // 忽略毫秒，避免毫秒差带来的 1 分钟误差
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

const pad = (n: number, len = 2) => String(Math.abs(n)).padStart(len, '0');

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

const WALL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 墙上时间 → 带偏移的 ISO 时间
 * @param wall 形如 "2026-09-24T12:30" 或 "2026-09-24T12:30:15"（即 <input type="datetime-local"> 的值）
 * @example wallTimeToIso('2026-09-24T12:30', 'Asia/Shanghai') === '2026-09-24T12:30:00+08:00'
 * @throws 格式不对或日期不存在（如 2 月 30 日）时抛错
 */
export function wallTimeToIso(wall: string, timeZone: string): string {
  const m = WALL_PATTERN.exec(wall);
  if (!m) throw new Error(`时间格式应为 YYYY-MM-DDTHH:mm：${wall}`);
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(naiveUtc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error(`日期不存在：${wall}`);
  }
  // 先用"把墙上时间当 UTC"得到的时刻估算偏移，再用修正后的时刻重算一次（处理夏令时切换附近的情况）
  let offset = offsetMinutesAt(new Date(naiveUtc), timeZone);
  offset = offsetMinutesAt(new Date(naiveUtc - offset * 60000), timeZone);
  return `${wall.length === 16 ? `${wall}:00` : wall}${formatOffset(offset)}`;
}

export interface ZonedDisplay {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
  /** YYYY-MM-DDTHH:mm，可直接作为 datetime-local 输入框的值 */
  wall: string;
}

/**
 * 时刻 → 指定时区的墙上时间（用于展示和回填表单）
 * @param instant ISO 字符串或 Date
 */
export function toZonedDisplay(instant: string | Date, timeZone: string): ZonedDisplay {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new Error(`不是有效的时间：${String(instant)}`);
  const w = wallPartsAt(d, timeZone);
  const date = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  const time = `${pad(w.hour)}:${pad(w.minute)}`;
  return { date, time, wall: `${date}T${time}` };
}

/**
 * 月份加减
 * @example shiftMonth('2026-01', -1) === '2025-12'
 */
export function shiftMonth(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`月份格式应为 YYYY-MM：${month}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}
