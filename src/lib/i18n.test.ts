import { describe, expect, it } from "vitest";
import { interpolate, pluralForm, translate } from "./i18n";

describe("pluralForm", () => {
  it("puts 1 and anything ending in 1 (but not 11) into 'one'", () => {
    expect(pluralForm(1)).toBe("one");
    expect(pluralForm(21)).toBe("one");
    expect(pluralForm(101)).toBe("one");
    // 11–14 are 'many' in Slavic pluralization, including 11 itself.
    expect(pluralForm(11)).toBe("many");
    expect(pluralForm(111)).toBe("many");
  });

  it("puts 2–4 (but not 12–14) into 'few'", () => {
    expect(pluralForm(2)).toBe("few");
    expect(pluralForm(4)).toBe("few");
    expect(pluralForm(22)).toBe("few");
    expect(pluralForm(12)).toBe("many");
    expect(pluralForm(14)).toBe("many");
  });

  it("puts zero and everything else into 'many'", () => {
    expect(pluralForm(0)).toBe("many");
    expect(pluralForm(5)).toBe("many");
    expect(pluralForm(100)).toBe("many");
  });
});

describe("interpolate", () => {
  it("replaces known placeholders and keeps unknown ones", () => {
    expect(interpolate("{n} runs", { n: 3 })).toBe("3 runs");
    expect(interpolate("{a} {b}", { a: 1 })).toBe("1 {b}");
  });

  it("stringifies numbers", () => {
    expect(interpolate("v{version}", { version: "1.2" })).toBe("v1.2");
  });

  it("returns the template untouched without params", () => {
    expect(interpolate("{n} runs")).toBe("{n} runs");
  });
});

describe("translate", () => {
  it("falls back to the English key when no translation exists", () => {
    // The key IS the English text, so this is a graceful degrade, not a leak
    // of internal identifiers.
    expect(translate("ua", "A string nobody translated")).toBe("A string nobody translated");
  });

  it("translates a plain string", () => {
    expect(translate("ua", "Run")).toBe("Запустити");
    expect(translate("en", "Run")).toBe("Run");
  });

  it("interpolates params into the translation", () => {
    expect(translate("ua", "exit {code}", { code: 1 })).toBe("вихід 1");
  });

  it("picks the plural form from params.n for both languages", () => {
    expect(translate("en", "{n} files", { n: 1 })).toBe("1 file");
    expect(translate("en", "{n} files", { n: 3 })).toBe("3 files");

    expect(translate("ua", "{n} scripts", { n: 1 })).toBe("1 скрипт");
    expect(translate("ua", "{n} scripts", { n: 3 })).toBe("3 скрипти");
    expect(translate("ua", "{n} scripts", { n: 11 })).toBe("11 скриптів");
  });

  it("uses the 'many' form when n is absent or not a number", () => {
    expect(translate("ua", "{n} files", {})).toBe("{n} файлів");
    expect(translate("en", "{n} files", { n: "many" })).toBe("many files");
  });
});
