import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScheduleOverviewBucket } from "@opencode-manager/shared/schemas";
import { ThroughputChart } from "./ThroughputChart";

const outcomes = {
  succeeded: 0,
  partial: 0,
  failed: 0,
  blocked: 0,
  skipped: 0,
  unreported: 0,
  cancelled: 0,
};

function bucket(succeeded: number): ScheduleOverviewBucket {
  return {
    start: 0,
    label: "11.07",
    runs: succeeded,
    outcomes: { ...outcomes, succeeded },
    avgDurationMs: null,
    maxConcurrent: 0,
    processed: 0,
    tokens: 0,
    estimatedCost: null,
  };
}

function runTicks(peak: number): string[] {
  const { container } = render(
    <ThroughputChart series={[bucket(peak)]} range="7d" hourly={false} />,
  );
  return [
    ...container.querySelectorAll('svg > g > text[text-anchor="end"]'),
  ].map((node) => node.textContent ?? "");
}

describe("ThroughputChart", () => {
  it.each([
    [1, ["0", "1", "2"]],
    [3, ["0", "2", "4"]],
    [4, ["0", "2", "4"]],
  ])("keeps distinct integer run ticks for a peak of %s", (peak, expected) => {
    expect(runTicks(peak)).toEqual(expected);
  });
});
