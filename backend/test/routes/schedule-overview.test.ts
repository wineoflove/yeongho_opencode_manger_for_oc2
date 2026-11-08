import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ScheduleService } from "../../src/services/schedules";
import { buildScheduleOverview } from "../../src/services/schedule-overview";
import { createScheduleRoutes } from "../../src/routes/schedules";

vi.mock("../../src/utils/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function setup() {
  const scheduleService = { getJob: vi.fn() } as unknown as ScheduleService;
  const overview = { get: vi.fn() };
  const app = new Hono();
  app.route("/schedules", createScheduleRoutes(scheduleService, overview));
  app.route("/repos/:id/schedules", createScheduleRoutes(scheduleService));
  return { app, overview, scheduleService };
}

const sample = (tz: string) =>
  buildScheduleOverview({
    jobs: [],
    runs: [],
    latest: new Map(),
    now: 1773027000000,
    windowDays: 7,
    tz,
    prices: new Map(),
    fireTimes: new Map(),
    deadlineMs: 60000,
  });

describe("schedule overview route", () => {
  it.each(["windowDays=14", "tz=Mars/Base"])(
    "rejects invalid overview query %s",
    async (query) => {
      const { app, overview } = setup();
      const response = await app.request(`/schedules/overview?${query}`);
      expect(response.status).toBe(400);
      expect(overview.get).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "Asia/Seoul"])(
    "serves overview with timezone %s before job routes",
    async (tz) => {
      const { app, overview, scheduleService } = setup();
      const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const body = sample(timezone);
      overview.get.mockResolvedValue(body);
      const response = await app.request(
        `/schedules/overview${tz ? `?tz=${tz}` : ""}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
      expect(overview.get).toHaveBeenCalledWith(7, timezone);
      expect(scheduleService.getJob).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed overview output", async () => {
    const { app, overview } = setup();
    overview.get.mockResolvedValue({ jobs: [] });
    expect((await app.request("/schedules/overview")).status).toBe(500);
  });

  it("is not exposed on repository-scoped schedule routes", async () => {
    const { app, overview } = setup();
    const response = await app.request("/repos/42/schedules/overview");
    expect(response.status).not.toBe(200);
    expect(overview.get).not.toHaveBeenCalled();
  });
});
