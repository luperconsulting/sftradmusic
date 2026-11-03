/** Placeholder catalog. These prices are not from GoHighLevel or Stripe. The owner replaces them. */
export const LESSON_PACKAGES = [
  { id: "placeholder-4", name: "Placeholder: 4 lessons", lessons: 4, amountCents: 38000, listCents: 40000, saveCents: 2000, popular: false },
  { id: "placeholder-8", name: "Placeholder: 8 lessons", lessons: 8, amountCents: 72000, listCents: 80000, saveCents: 8000, popular: true },
  { id: "placeholder-12", name: "Placeholder: 12 lessons", lessons: 12, amountCents: 102000, listCents: 120000, saveCents: 18000, popular: false },
] as const;

export type LessonPackageId = (typeof LESSON_PACKAGES)[number]["id"];

export function formatPackageMoney(cents: number) {
  const amount = cents / 100;
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export function lessonPackageById(id: string) {
  return LESSON_PACKAGES.find((item) => item.id === id) ?? null;
}

export function packageLessonsFor(rows: { target: string; meta: Record<string, unknown> }[], studentId: string) {
  return rows.filter((row) => row.target === studentId).reduce((sum, row) => sum + Number(row.meta.lessons ?? 0), 0);
}
