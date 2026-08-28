import type { Condition, InputSpec } from "../../types/schema";

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function evaluateCondition(
  cond: Condition,
  values: Record<string, unknown>,
): boolean {
  switch (cond.op) {
    case "eq": {
      return deepEqual(values[cond.key], cond.value);
    }
    case "ne": {
      return !deepEqual(values[cond.key], cond.value);
    }
    case "truthy": {
      const v = values[cond.key];
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return v.length > 0;
      if (typeof v === "number") return v !== 0;
      if (Array.isArray(v)) return v.length > 0;
      return !!v;
    }
    default:
      return true;
  }
}

export function isFieldVisible(
  input: InputSpec,
  values: Record<string, unknown>,
): boolean {
  if (!input.visible_if) return true;
  return evaluateCondition(input.visible_if, values);
}

export interface ValidationError {
  key: string;
  message: string;
}

const regexCache = new Map<string, RegExp>();

export function validateField(
  input: InputSpec,
  value: unknown,
): string | null {
  if (input.required) {
    if (value === undefined || value === null || value === "") {
      return "Required";
    }
    if (Array.isArray(value) && value.length === 0) {
      return "Required";
    }
  }

  switch (input.type) {
    case "int": {
      if (value === undefined || value === null || value === "") return null;
      const n = Number(value);
      if (isNaN(n)) return "Must be a number";
      if (input.min !== null && n < input.min) return `Min: ${input.min}`;
      if (input.max !== null && n > input.max) return `Max: ${input.max}`;
      break;
    }
    case "float": {
      if (value === undefined || value === null || value === "") return null;
      const n = Number(value);
      if (isNaN(n)) return "Must be a number";
      if (input.min !== null && n < input.min) return `Min: ${input.min}`;
      if (input.max !== null && n > input.max) return `Max: ${input.max}`;
      break;
    }
    case "string": {
      if (value && typeof value === "string") {
        if (input.pattern) {
          let re = regexCache.get(input.pattern);
          if (!re) {
            try {
              re = new RegExp(input.pattern);
              regexCache.set(input.pattern, re);
            } catch {
              return "Invalid pattern in schema";
            }
          }
          if (!re.test(value)) return "Invalid format";
        }
        if (input.max_len !== null && value.length > input.max_len) {
          return `Max length: ${input.max_len}`;
        }
      }
      break;
    }
  }

  return null;
}

export function validateForm(
  inputs: InputSpec[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const input of inputs) {
    if (!isFieldVisible(input, values)) continue;
    const err = validateField(input, values[input.key]);
    if (err) errors[input.key] = err;
  }
  return errors;
}

export function isFormValid(
  inputs: InputSpec[],
  values: Record<string, unknown>,
): boolean {
  return Object.keys(validateForm(inputs, values)).length === 0;
}
