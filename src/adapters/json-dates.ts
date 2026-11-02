/** JSON with dates kept as dates: a `Date` becomes `{ $date }` and comes back as a `Date`. */
export function stringifyWithDates(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, raw: unknown) {
    const original = this[key];
    return original instanceof Date ? { $date: original.toISOString() } : raw;
  });
}

export function parseWithDates<T>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && '$date' in value && typeof (value as { $date: unknown }).$date === 'string'
      ? new Date((value as { $date: string }).$date)
      : value,
  ) as T;
}
