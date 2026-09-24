import { describe, expect, it } from 'vitest';
import { shiftMonth, toZonedDisplay, wallTimeToIso } from '../src/index.ts';

describe('wallTimeToIso', () => {
  it.each([
    ['2026-09-24T12:30', 'Asia/Shanghai', '2026-09-24T12:30:00+08:00'],
    ['2026-09-24T00:00:05', 'Asia/Shanghai', '2026-09-24T00:00:05+08:00'],
    ['2026-01-15T08:00', 'UTC', '2026-01-15T08:00:00+00:00'],
    // 有夏令时的时区：冬令时 -05:00，夏令时 -04:00
    ['2026-01-15T08:00', 'America/New_York', '2026-01-15T08:00:00-05:00'],
    ['2026-07-15T08:00', 'America/New_York', '2026-07-15T08:00:00-04:00'],
    // 半小时偏移的时区
    ['2026-09-24T12:00', 'Asia/Kolkata', '2026-09-24T12:00:00+05:30'],
  ])('%s @ %s → %s', (wall, tz, iso) => {
    expect(wallTimeToIso(wall, tz)).toBe(iso);
  });

  it('往返：墙上时间 → ISO → 墙上时间 一致（含夏令时时区的全年各月）', () => {
    for (const tz of ['Asia/Shanghai', 'America/New_York', 'Europe/London']) {
      for (let month = 1; month <= 12; month++) {
        const wall = `2026-${String(month).padStart(2, '0')}-10T13:45`;
        expect(toZonedDisplay(wallTimeToIso(wall, tz), tz).wall).toBe(wall);
      }
    }
  });

  it.each(['2026-09-24 12:30', '2026-9-24T12:30', '2026-09-24', 'abc', '2026-09-24T25:00', '2026-02-30T10:00'])(
    '反向：非法输入 %j 抛错',
    (wall) => {
      expect(() => wallTimeToIso(wall, 'Asia/Shanghai')).toThrow();
    },
  );
});

describe('toZonedDisplay', () => {
  it('正向：UTC 时刻按北京时间显示（跨日）', () => {
    expect(toZonedDisplay('2026-01-31T16:30:00Z', 'Asia/Shanghai')).toEqual({
      date: '2026-02-01',
      time: '00:30',
      wall: '2026-02-01T00:30',
    });
  });

  it('反向：无效时间抛错', () => {
    expect(() => toZonedDisplay('not a date', 'Asia/Shanghai')).toThrow(/不是有效的时间/);
  });
});

describe('shiftMonth', () => {
  it.each([
    ['2026-09', 1, '2026-10'],
    ['2026-12', 1, '2027-01'],
    ['2026-01', -1, '2025-12'],
    ['2026-03', -14, '2025-01'],
  ])('%s %+d → %s', (m, d, r) => {
    expect(shiftMonth(m, d)).toBe(r);
  });

  it('反向：格式不对抛错', () => {
    expect(() => shiftMonth('2026-9', 1)).toThrow();
  });
});
