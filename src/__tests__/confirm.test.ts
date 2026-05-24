import { assertConfirm } from "../tools/confirm";

describe("assertConfirm", () => {
  test("throws when confirm is undefined and dry_run is false", () => {
    expect(() => assertConfirm(undefined, false, "place_trade")).toThrow(
      /place_trade requires confirm="CONFIRM"/
    );
  });

  test("throws when confirm is an empty string and dry_run is false", () => {
    expect(() => assertConfirm("", false, "place_trade")).toThrow(/confirm="CONFIRM"/);
  });

  test("throws when confirm is lowercase 'confirm'", () => {
    expect(() => assertConfirm("confirm", false, "place_trade")).toThrow(/case-sensitive/);
  });

  test("throws when confirm has trailing whitespace", () => {
    expect(() => assertConfirm("CONFIRM ", false, "place_trade")).toThrow(/exact/);
  });

  test("throws when confirm has leading whitespace", () => {
    expect(() => assertConfirm(" CONFIRM", false, "place_trade")).toThrow(/exact/);
  });

  test("throws when confirm is similar but different (e.g. 'YES')", () => {
    expect(() => assertConfirm("YES", false, "place_trade")).toThrow(/confirm="CONFIRM"/);
  });

  test("passes when confirm is exactly 'CONFIRM' and dry_run is false", () => {
    expect(() => assertConfirm("CONFIRM", false, "place_trade")).not.toThrow();
  });

  test("passes when dry_run is true even with no confirm", () => {
    expect(() => assertConfirm(undefined, true, "place_trade")).not.toThrow();
  });

  test("passes when dry_run is true and confirm is wrong", () => {
    expect(() => assertConfirm("nope", true, "place_trade")).not.toThrow();
  });

  test("includes the tool name in the error for operator clarity", () => {
    expect(() => assertConfirm(undefined, false, "execute_quote")).toThrow(/execute_quote/);
  });

  test("error message instructs caller to use dry_run for preview", () => {
    expect(() => assertConfirm(undefined, false, "place_trade")).toThrow(/dry_run/);
  });
});
