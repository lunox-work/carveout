import { CURRENCIES, format, type Currency } from "@fx/money";
import Stripe from "stripe";
import { tax } from "@/tax";
import "./cart.css";

export interface Line {
  readonly cents: number;
  readonly quantity: number;
}

export function subtotal(lines: readonly Line[]): number {
  return lines.reduce((sum, line) => sum + line.cents * line.quantity, 0);
}

export function total(lines: readonly Line[], currency: Currency): string {
  const cents = subtotal(lines);
  return format(cents + tax(cents), currency);
}

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

export function client(): Stripe {
  return new Stripe(process.env.STRIPE_KEY ?? "");
}
