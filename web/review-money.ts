/** Display currency amounts while preserving integer minor units at the API boundary. */
export function currencyDigits(currency: string | null): number {
  if (!currency) return 2;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits!;
}
export function displayMoney(
  value: number | null,
  currency: string | null,
): string {
  if (value === null) return "";
  const digits = currencyDigits(currency);
  const text = String(Math.abs(value)).padStart(digits + 1, "0");
  return (
    (value < 0 ? "-" : "") +
    (digits ? text.slice(0, -digits) + "." + text.slice(-digits) : text)
  );
}
export function readMoney(
  value: string,
  currency: string | null,
): number | null {
  const text = value.trim().replace(",", ".");
  if (!text) return null;
  const digits = currencyDigits(currency);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text))
    throw Error(
      "Enter an amount without thousands separators, or leave it blank if unknown.",
    );
  const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
  if (fraction.length > digits)
    throw Error(
      `${currency ?? "This currency"} amounts allow ${digits} decimal places.`,
    );
  const amount =
    Number(whole + fraction.padEnd(digits, "0")) *
    (text.startsWith("-") ? -1 : 1);
  if (!Number.isSafeInteger(amount)) throw Error("Amount is too large.");
  return amount;
}
