import type { ApplicationSummary } from "@application-checker/contracts";

export type AppliedAtSort = "default" | "desc" | "asc";

function appliedAtTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortApplicationsByAppliedAt(
  items: ApplicationSummary[],
  order: AppliedAtSort,
): ApplicationSummary[] {
  if (order === "default") return items;
  return [...items].sort((left, right) => {
    const leftTimestamp = appliedAtTimestamp(left.appliedAt);
    const rightTimestamp = appliedAtTimestamp(right.appliedAt);
    if (leftTimestamp === null && rightTimestamp === null) return 0;
    if (leftTimestamp === null) return order === "asc" ? -1 : 1;
    if (rightTimestamp === null) return order === "asc" ? 1 : -1;
    return order === "asc"
      ? leftTimestamp - rightTimestamp
      : rightTimestamp - leftTimestamp;
  });
}

