export function readKiroCredits(summaries: unknown): number | null {
  if (!Array.isArray(summaries)) return null;
  let credits = 0;
  let found = false;
  for (const summary of summaries) {
    if (typeof summary !== "object" || summary === null) continue;
    const entry = summary as { unit?: unknown; usage?: unknown };
    if (
      entry.unit !== "credit" ||
      typeof entry.usage !== "number" ||
      !Number.isFinite(entry.usage) ||
      entry.usage < 0
    ) {
      continue;
    }
    credits += entry.usage;
    found = true;
  }
  return found && Number.isFinite(credits) ? credits : null;
}
