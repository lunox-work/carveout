import { total, type Line } from "./cart";

export function receipt(lines: readonly Line[]): string {
  return `Total: ${total(lines, "usd")}`;
}
