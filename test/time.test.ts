import { describe, expect, test } from "vitest";
import { duration, exactTime, runTime } from "../src/ui/time.js";

describe("duration", () => {
  test.each([
    [-100, "0 ms"], [0, "0 ms"], [0.6, "1 ms"], [999, "999 ms"],
    [1000, "1.0s"], [9999, "10.0s"], [10000, "10s"], [59999, "60s"],
    [60000, "1m 00s"], [124000, "2m 04s"], [3599999, "59m 59s"],
    [3600000, "1h 00m"], [3780000, "1h 03m"], [360000000, "100h 00m"],
  ])("%s ms → %s", (ms, text) => expect(duration(ms)).toBe(text));
});

describe("runTime", () => {
  const now = Date.parse("2026-06-15T12:00:00Z");
  test.each([
    [-1000, "just now"], [0, "just now"], [9999, "just now"], [10000, "10s ago"],
    [59999, "59s ago"], [60000, "1m ago"], [3599999, "59m ago"],
    [3600000, "1h ago"], [86399999, "23h ago"], [86400000, "yesterday 12:00"],
    [2 * 86400000, "Sat 12:00"], [7 * 86400000 - 1, "Mon 12:00"],
    [7 * 86400000, "Jun 8 12:00"],
  ])("age %s → %s", (age, text) => expect(runTime(now - age, now, "UTC")).toBe(text));

  test("calendar yesterday survives year rollover; older years use exact dates", () => {
    const next = Date.parse("2026-01-01T12:00:00Z");
    expect(runTime(Date.parse("2025-12-31T11:00:00Z"), next, "UTC")).toBe("yesterday 11:00");
    expect(runTime(Date.parse("2025-01-01T11:00:00Z"), next, "UTC")).toBe("2025-01-01 11:00");
  });
  test("uses the supplied timezone's calendar, including a DST yesterday", () => {
    expect(runTime(Date.parse("2026-03-08T06:30:00Z"), Date.parse("2026-03-09T07:00:00Z"), "America/New_York")).toBe("yesterday 01:30");
    expect(runTime(now - 86400000, now, "Asia/Tokyo")).toBe("yesterday 21:00");
  });
  test("exact timing includes local date, seconds and the instant's timezone offset", () => {
    expect(exactTime(now, "UTC")).toBe("2026-06-15 12:00:00 GMT+00:00");
    expect(exactTime(now, "America/New_York")).toBe("2026-06-15 08:00:00 GMT-04:00");
    expect(exactTime(Date.parse("2026-01-01T00:00:05Z"), "America/New_York")).toBe("2025-12-31 19:00:05 GMT-05:00");
  });
});
