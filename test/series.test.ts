import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SERIES_ENV,
  SeriesError,
  loadSeries,
  parseSeriesArg,
  promptMeta,
  requireStep,
  resolveSeries,
  seriesPaths,
  validateProfile,
} from "../src/series.js";
import type { SeriesProfile } from "../src/series.js";

const profile: SeriesProfile = {
  id: "demo",
  title: "Demo Series",
  author: "A. Writer",
  books: [{ number: 1, title: "Book One" }],
  extraction: { notes: ["rule A"], redescribeNotes: [] },
  preprocess: { excludeSections: [], sectionLabels: {} },
  steps: { crawlerNumbers: false },
};

describe("parseSeriesArg", () => {
  it("extracts --series <id> from any position and returns the remaining args", () => {
    expect(parseSeriesArg(["--series", "dcc", "8"])).toEqual({ id: "dcc", rest: ["8"] });
    expect(parseSeriesArg(["8", "--series", "dcc"])).toEqual({ id: "dcc", rest: ["8"] });
    expect(parseSeriesArg(["--through", "B2·C4", "--series", "dcc"])).toEqual({ id: "dcc", rest: ["--through", "B2·C4"] });
  });

  it("accepts the --series=<id> form", () => {
    expect(parseSeriesArg(["--series=dcc", "x"])).toEqual({ id: "dcc", rest: ["x"] });
  });

  it("returns null id when the flag is absent", () => {
    expect(parseSeriesArg(["8"])).toEqual({ id: null, rest: ["8"] });
  });

  it("rejects a valueless flag (last arg, next arg is a flag, or empty =)", () => {
    expect(() => parseSeriesArg(["8", "--series"])).toThrow(SeriesError);
    expect(() => parseSeriesArg(["--series", "--through"])).toThrow(SeriesError);
    expect(() => parseSeriesArg(["--series="])).toThrow(SeriesError);
  });
});

describe("seriesPaths", () => {
  it("derives every path from <root>/<id>", () => {
    const p = seriesPaths("/cf", "dcc");
    expect(p.id).toBe("dcc");
    expect(p.root).toBe("/cf/dcc");
    expect(p.profile).toBe("/cf/dcc/series.json");
    expect(p.outputDir).toBe("/cf/dcc/output");
    expect(p.registry).toBe("/cf/dcc/output/registry.json");
    expect(p.logDir).toBe("/cf/dcc/log");
    expect(p.corrections).toBe("/cf/dcc/corrections.json");
    expect(p.epubsDir).toBe("/cf/dcc/epubs");
    expect(p.dataDir).toBe("/cf/dcc/data");
    expect(p.wfDir).toBe("/cf/dcc/data/_wf");
    expect(p.epub(3)).toBe("/cf/dcc/epubs/book3.epub");
    expect(p.bookDir(3)).toBe("/cf/dcc/data/book3");
    expect(p.sectionsDir(3)).toBe("/cf/dcc/data/book3/sections");
    expect(p.manifest(3)).toBe("/cf/dcc/data/book3/manifest.json");
  });
});

describe("validateProfile", () => {
  it("accepts a complete profile and returns a typed copy", () => {
    expect(validateProfile(profile, "demo")).toEqual(profile);
  });

  it("rejects an id that does not match the directory", () => {
    expect(() => validateProfile(profile, "other")).toThrow(/does not match directory/);
  });

  it("rejects missing or mistyped fields with the field name in the message", () => {
    const noTitle: Record<string, unknown> = { ...profile };
    delete noTitle.title;
    expect(() => validateProfile(noTitle, "demo")).toThrow(/"title"/);
    expect(() => validateProfile({ ...profile, books: [{ number: "1", title: "x" }] }, "demo")).toThrow(/"books"/);
    expect(() => validateProfile({ ...profile, extraction: { notes: "nope", redescribeNotes: [] } }, "demo")).toThrow(/"extraction"/);
    expect(() => validateProfile({ ...profile, preprocess: { excludeSections: [], sectionLabels: { a: 1 } } }, "demo")).toThrow(/"preprocess"/);
    expect(() => validateProfile({ ...profile, steps: {} }, "demo")).toThrow(/"steps"/);
    expect(() => validateProfile("not an object", "demo")).toThrow(SeriesError);
  });

  it("rejects sectionLabels values that are not anchor-safe labels", () => {
    for (const label of ["Part One", "", "Sync·2", "a¶b", "x[1]"]) {
      expect(
        () => validateProfile({ ...profile, preprocess: { excludeSections: [], sectionLabels: { a: label } } }, "demo"),
        label,
      ).toThrow(/sectionLabels/);
    }
    expect(
      () => validateProfile({ ...profile, preprocess: { excludeSections: [], sectionLabels: { a: "Synchronism-2_x" } } }, "demo"),
    ).not.toThrow();
  });
});

describe("loadSeries / resolveSeries", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "series-test-"));
    mkdirSync(join(root, "demo"));
    writeFileSync(join(root, "demo", "series.json"), JSON.stringify(profile), "utf8");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("loads paths and the validated profile", () => {
    const { paths, profile: p } = loadSeries(root, "demo");
    expect(paths.root).toBe(join(root, "demo"));
    expect(p.title).toBe("Demo Series");
  });

  it("fails clearly when the series dir or profile is missing", () => {
    expect(() => loadSeries(root, "ghost")).toThrow(/does not exist/);
    mkdirSync(join(root, "bare"));
    expect(() => loadSeries(root, "bare")).toThrow(/series\.json not found/);
  });

  it("fails clearly on unparseable JSON", () => {
    writeFileSync(join(root, "demo", "series.json"), "{ nope", "utf8");
    expect(() => loadSeries(root, "demo")).toThrow(/could not parse/);
  });

  it("resolves from the flag, else the env var, flag winning", () => {
    const byFlag = resolveSeries(["--series", "demo", "7"], { casefilesRoot: root, env: {} });
    expect(byFlag.paths.id).toBe("demo");
    expect(byFlag.rest).toEqual(["7"]);
    const byEnv = resolveSeries(["7"], { casefilesRoot: root, env: { [SERIES_ENV]: "demo" } });
    expect(byEnv.paths.id).toBe("demo");
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "series.json"), JSON.stringify({ ...profile, id: "other" }), "utf8");
    const both = resolveSeries(["--series", "other"], { casefilesRoot: root, env: { [SERIES_ENV]: "demo" } });
    expect(both.paths.id).toBe("other");
  });

  it("fails when neither flag nor env names a series", () => {
    expect(() => resolveSeries(["7"], { casefilesRoot: root, env: {} })).toThrow(/--series <id>/);
  });
});

describe("promptMeta / requireStep", () => {
  it("selects the right notes list per prompt kind", () => {
    expect(promptMeta(profile, "extraction")).toEqual({ id: "demo", title: "Demo Series", author: "A. Writer", notes: ["rule A"] });
    expect(promptMeta(profile, "redescribe").notes).toEqual([]);
  });

  it("requireStep throws when a step is disabled and passes when enabled", () => {
    expect(() => requireStep(profile, "crawlerNumbers")).toThrow(/crawlerNumbers/);
    expect(() => requireStep({ ...profile, steps: { crawlerNumbers: true } }, "crawlerNumbers")).not.toThrow();
  });
});
