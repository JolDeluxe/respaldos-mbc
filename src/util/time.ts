const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const map: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  return { y: map.year!, m: map.month!, d: map.day!, h: map.hour!, mi: map.minute!, s: map.second! };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Diferencia (hora local - UTC) en ms para `date` en `tz`. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedTimeToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

/** "2026-11-24_235900" en la zona horaria indicada. */
export function formatStamp(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}_${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
}

export function yearMonth(date: Date, tz: string): { year: string; month: string } {
  const p = zonedParts(date, tz);
  return { year: String(p.y), month: pad(p.m) };
}

export interface DailyCron {
  minute: number;
  hour: number;
}

/** Interpreta expresiones diarias "m h * * *". Devuelve undefined si no es diaria simple. */
export function parseDailyCron(expr: string): DailyCron | undefined {
  const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(expr);
  if (!m) return undefined;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return undefined;
  return { minute, hour };
}

/** Último instante programado (hh:mm diario en `tz`) que ya pasó respecto a `now`. */
export function lastScheduledSlot(now: Date, tz: string, daily: DailyCron): Date {
  const p = zonedParts(now, tz);
  let slot = zonedTimeToUtc(p.y, p.m, p.d, daily.hour, daily.minute, 0, tz);
  if (slot.getTime() > now.getTime()) {
    const prev = new Date(Date.UTC(p.y, p.m - 1, p.d - 1));
    slot = zonedTimeToUtc(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), daily.hour, daily.minute, 0, tz);
  }
  return slot;
}
