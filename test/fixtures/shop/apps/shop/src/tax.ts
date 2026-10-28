export const TAX_RATE = 0.1;

export function tax(cents: number): number {
  return Math.round(cents * TAX_RATE);
}
