import { describe, expect, it } from "vitest";
import type { ApplicationSummary } from "@application-checker/contracts";
import { sortApplicationsByAppliedAt } from "./application-sorting";

function application(id: string, appliedAt: string | null): ApplicationSummary {
  return { id, appliedAt } as ApplicationSummary;
}

describe("application delivery date sorting", () => {
  const items = [
    application("middle", "2026-06-15"),
    application("empty", null),
    application("latest", "2026-07-01"),
    application("earliest", "2026-05-20"),
  ];

  it("keeps the API order by default", () => {
    expect(sortApplicationsByAppliedAt(items, "default")).toBe(items);
  });

  it("puts missing dates first in ascending order", () => {
    expect(sortApplicationsByAppliedAt(items, "asc").map((item) => item.id))
      .toEqual(["empty", "earliest", "middle", "latest"]);
  });

  it("puts missing dates last in descending order", () => {
    expect(sortApplicationsByAppliedAt(items, "desc").map((item) => item.id))
      .toEqual(["latest", "middle", "earliest", "empty"]);
  });
});

