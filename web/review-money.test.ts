import { expect, it } from "vitest";
import { displayMoney, readMoney } from "./review-money";
it("round trips signed receipt amounts without floating-point rounding", () => {
  for (const currency of ["DKK", "JPY", "KWD", null])
    for (const amount of [0, 1, -1, 29, 35886, 100000000000])
      expect(readMoney(displayMoney(amount, currency), currency)).toBe(amount);
  expect(displayMoney(35886, "DKK")).toBe("358.86");
  expect(readMoney("71,77", "DKK")).toBe(7177);
  expect(readMoney("", "DKK")).toBeNull();
});
it("rejects ambiguous grouped amounts and excessive decimal precision", () => {
  for (const value of ["1,234.56", "1.234,56", "1e3", "0.001", "NaN"])
    expect(() => readMoney(value, "DKK")).toThrow();
  expect(() => readMoney("1.1", "JPY")).toThrow();
  expect(readMoney("1.001", "KWD")).toBe(1001);
});
