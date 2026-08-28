import { describe, it, expect } from "vitest";
import {
  deepEqual,
  evaluateCondition,
  isFieldVisible,
  validateField,
  validateForm,
  isFormValid,
} from "./field-utils";
import type { InputSpec, Condition } from "../../types/schema";

// --- helpers ---------------------------------------------------------------

function stringField(over: Partial<InputSpec> = {}): InputSpec {
  return {
    key: "f",
    label: "F",
    help: null,
    required: false,
    default: "",
    group: null,
    visible_if: null,
    binding: { type: "arg", flag: "--f", style: "space" },
    type: "string",
    pattern: null,
    max_len: null,
    ...over,
  } as InputSpec;
}

function intField(over: Partial<InputSpec> = {}): InputSpec {
  return {
    key: "n",
    label: "N",
    help: null,
    required: false,
    default: 0,
    group: null,
    visible_if: null,
    binding: { type: "arg", flag: "--n", style: "space" },
    type: "int",
    min: null,
    max: null,
    ...over,
  } as InputSpec;
}

// --- deepEqual -------------------------------------------------------------

describe("deepEqual", () => {
  it("primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
  });

  it("null and undefined", () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(null, 0)).toBe(false);
    expect(deepEqual(undefined, false)).toBe(false);
  });

  it("arrays", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(deepEqual([], [])).toBe(true);
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
  });

  it("objects", () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  });

  it("nested objects", () => {
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
  });
});

// --- evaluateCondition -----------------------------------------------------

describe("evaluateCondition", () => {
  it("eq matches value", () => {
    const cond: Condition = { op: "eq", key: "mode", value: "fast" };
    expect(evaluateCondition(cond, { mode: "fast" })).toBe(true);
    expect(evaluateCondition(cond, { mode: "slow" })).toBe(false);
    expect(evaluateCondition(cond, {})).toBe(false);
  });

  it("eq with array value", () => {
    const cond: Condition = { op: "eq", key: "tags", value: ["a", "b"] };
    expect(evaluateCondition(cond, { tags: ["a", "b"] })).toBe(true);
    expect(evaluateCondition(cond, { tags: ["a"] })).toBe(false);
  });

  it("ne negates eq", () => {
    const cond: Condition = { op: "ne", key: "mode", value: "fast" };
    expect(evaluateCondition(cond, { mode: "fast" })).toBe(false);
    expect(evaluateCondition(cond, { mode: "slow" })).toBe(true);
    expect(evaluateCondition(cond, {})).toBe(true);
  });

  it("truthy for boolean", () => {
    const cond: Condition = { op: "truthy", key: "verbose" };
    expect(evaluateCondition(cond, { verbose: true })).toBe(true);
    expect(evaluateCondition(cond, { verbose: false })).toBe(false);
  });

  it("truthy for string (non-empty)", () => {
    const cond: Condition = { op: "truthy", key: "name" };
    expect(evaluateCondition(cond, { name: "abc" })).toBe(true);
    expect(evaluateCondition(cond, { name: "" })).toBe(false);
  });

  it("truthy for number (non-zero)", () => {
    const cond: Condition = { op: "truthy", key: "count" };
    expect(evaluateCondition(cond, { count: 5 })).toBe(true);
    expect(evaluateCondition(cond, { count: 0 })).toBe(false);
  });

  it("truthy for array (non-empty)", () => {
    const cond: Condition = { op: "truthy", key: "items" };
    expect(evaluateCondition(cond, { items: [1] })).toBe(true);
    expect(evaluateCondition(cond, { items: [] })).toBe(false);
  });

  it("truthy for missing key is false", () => {
    const cond: Condition = { op: "truthy", key: "missing" };
    expect(evaluateCondition(cond, {})).toBe(false);
  });
});

// --- isFieldVisible --------------------------------------------------------

describe("isFieldVisible", () => {
  it("visible when no condition", () => {
    expect(isFieldVisible(stringField(), {})).toBe(true);
  });

  it("respects visible_if eq", () => {
    const field = stringField({
      visible_if: { op: "eq", key: "mode", value: "advanced" },
    });
    expect(isFieldVisible(field, { mode: "advanced" })).toBe(true);
    expect(isFieldVisible(field, { mode: "basic" })).toBe(false);
  });

  it("respects visible_if truthy", () => {
    const field = stringField({
      visible_if: { op: "truthy", key: "verbose" },
    });
    expect(isFieldVisible(field, { verbose: true })).toBe(true);
    expect(isFieldVisible(field, { verbose: false })).toBe(false);
  });
});

// --- validateField ---------------------------------------------------------

describe("validateField", () => {
  it("required string empty → error", () => {
    expect(validateField(stringField({ required: true }), "")).toBe("Required");
  });

  it("required string non-empty → ok", () => {
    expect(validateField(stringField({ required: true }), "hello")).toBeNull();
  });

  it("optional string empty → ok", () => {
    expect(validateField(stringField({ required: false }), "")).toBeNull();
  });

  it("required array empty → error", () => {
    expect(validateField(stringField({ required: true }), [])).toBe("Required");
  });

  it("required array non-empty → ok", () => {
    expect(validateField(stringField({ required: true }), ["x"])).toBeNull();
  });

  it("int non-numeric → error", () => {
    expect(validateField(intField(), "abc")).toBe("Must be a number");
  });

  it("int below min → error", () => {
    expect(validateField(intField({ min: 10 } as Partial<InputSpec>), 5)).toBe("Min: 10");
  });

  it("int above max → error", () => {
    expect(validateField(intField({ max: 100 } as Partial<InputSpec>), 200)).toBe("Max: 100");
  });

  it("int within range → ok", () => {
    expect(validateField(intField({ min: 1, max: 10 } as Partial<InputSpec>), 5)).toBeNull();
  });

  it("int empty when not required → ok", () => {
    expect(validateField(intField(), "")).toBeNull();
  });

  it("string pattern match → ok", () => {
    expect(
      validateField(stringField({ pattern: "^\\d{4}$" } as Partial<InputSpec>), "1234"),
    ).toBeNull();
  });

  it("string pattern mismatch → error", () => {
    expect(
      validateField(stringField({ pattern: "^\\d{4}$" } as Partial<InputSpec>), "abc"),
    ).toBe("Invalid format");
  });

  it("string exceeds max_len → error", () => {
    expect(
      validateField(stringField({ max_len: 5 } as Partial<InputSpec>), "abcdef"),
    ).toBe("Max length: 5");
  });

  it("string within max_len → ok", () => {
    expect(
      validateField(stringField({ max_len: 5 } as Partial<InputSpec>), "abc"),
    ).toBeNull();
  });
});

// --- validateForm / isFormValid --------------------------------------------

describe("validateForm", () => {
  it("collects errors for all invalid visible fields", () => {
    const inputs: InputSpec[] = [
      stringField({ key: "a", required: true }),
      intField({ key: "b", min: 0 } as Partial<InputSpec>),
    ];
    const errors = validateForm(inputs, { a: "", b: -1 });
    expect(errors.a).toBe("Required");
    expect(errors.b).toBe("Min: 0");
  });

  it("skips hidden fields", () => {
    const inputs: InputSpec[] = [
      stringField({
        key: "a",
        required: true,
        visible_if: { op: "eq", key: "mode", value: "advanced" },
      }),
    ];
    const errors = validateForm(inputs, { mode: "basic", a: "" });
    expect(errors.a).toBeUndefined();
  });

  it("no errors when all valid", () => {
    const inputs: InputSpec[] = [
      stringField({ key: "a", required: true }),
      intField({ key: "b", min: 0 } as Partial<InputSpec>),
    ];
    const errors = validateForm(inputs, { a: "hello", b: 5 });
    expect(Object.keys(errors)).toHaveLength(0);
  });
});

describe("isFormValid", () => {
  it("true when no errors", () => {
    const inputs: InputSpec[] = [stringField({ key: "a", required: true })];
    expect(isFormValid(inputs, { a: "hello" })).toBe(true);
  });

  it("false when errors exist", () => {
    const inputs: InputSpec[] = [stringField({ key: "a", required: true })];
    expect(isFormValid(inputs, { a: "" })).toBe(false);
  });

  it("true when required field is hidden", () => {
    const inputs: InputSpec[] = [
      stringField({
        key: "a",
        required: true,
        visible_if: { op: "truthy", key: "show" },
      }),
    ];
    expect(isFormValid(inputs, { show: false, a: "" })).toBe(true);
  });
});
