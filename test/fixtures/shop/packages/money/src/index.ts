export const CURRENCIES = ["usd", "eur"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function format(cents: number, currency: Currency): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}
