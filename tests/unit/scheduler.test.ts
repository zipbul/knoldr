import { describe, test, expect } from "bun:test";

// Test the shouldRun logic (extracted for testability)
function shouldRun(schedule: string, lastFetchedAt: Date | null): boolean {
  if (!lastFetchedAt) return true;

  const match = schedule.match(/\*\/(\d+)/);
  if (match) {
    const intervalHours = Number(match[1]);
    const elapsed = (Date.now() - lastFetchedAt.getTime()) / (1000 * 60 * 60);
    return elapsed >= intervalHours;
  }

  if (schedule.includes("0 0 ") || schedule.includes("0 */24")) {
    const elapsed = (Date.now() - lastFetchedAt.getTime()) / (1000 * 60 * 60);
    return elapsed >= 24;
  }

  const elapsed = (Date.now() - lastFetchedAt.getTime()) / (1000 * 60 * 60);
  return elapsed >= 6;
}

describe("shouldRun (schedule logic)", () => {
  test("runs if never fetched", () => {
    expect(shouldRun("0 */4 * * *", null)).toBe(true);
  });

  test("runs if interval elapsed (every 4 hours)", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    expect(shouldRun("0 */4 * * *", fiveHoursAgo)).toBe(true);
  });

  test("skips if interval not elapsed", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(shouldRun("0 */4 * * *", twoHoursAgo)).toBe(false);
  });

  test("daily schedule (0 0 * * *)", () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    expect(shouldRun("0 0 * * *", twoDaysAgo)).toBe(true);

    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    expect(shouldRun("0 0 * * *", tenHoursAgo)).toBe(false);
  });

  test("every 6 hours (*/6)", () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    expect(shouldRun("0 */6 * * *", sevenHoursAgo)).toBe(true);

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(shouldRun("0 */6 * * *", threeHoursAgo)).toBe(false);
  });

  test("default fallback: 6 hours", () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    expect(shouldRun("some weird cron", sevenHoursAgo)).toBe(true);

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(shouldRun("some weird cron", threeHoursAgo)).toBe(false);
  });

  test("boundary: exactly at interval", () => {
    const exactlyFourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    expect(shouldRun("0 */4 * * *", exactlyFourHoursAgo)).toBe(true);
  });
});
