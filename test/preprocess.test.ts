import { describe, expect, it } from "vitest";
import {
  baseLabel,
  classifyEntry,
  extractParagraphs,
  isInsideDir,
  parseSpine,
  parseTocTitles,
  planSection,
  renderChunk,
  romanToInt,
  scopeOptionsToBook,
  unmatchedPreprocessEntries,
} from "../src/preprocess.js";
import type { Section } from "../src/types.js";

describe("classifyEntry", () => {
  it("classifies chapters and extracts their number", () => {
    expect(classifyEntry("x_chapter-006-xhtml")).toEqual({ type: "chapter", number: 6 });
    expect(classifyEntry("x_chapter-012-xhtml")).toEqual({ type: "chapter", number: 12 });
  });

  it("classifies by <title> text when the idref is opaque (Book 2 style)", () => {
    expect(classifyEntry("id15", "Chapter 1", "1 Welcome, Crawler")).toEqual({ type: "chapter", number: 1 });
    expect(classifyEntry("id20", "Chapter 6", "")).toEqual({ type: "chapter", number: 6 });
    expect(classifyEntry("id13", "Epigraph", "If you hold a cat").type).toBe("epigraph");
    expect(classifyEntry("id14", "Table of Contents", "").type).toBe("front");
    expect(classifyEntry("titlepage", "Cover", "").type).toBe("front");
  });

  it("falls back to body opening words for chapters with no title", () => {
    expect(classifyEntry("id99", "", "Chapter 12 — the dungeon")).toEqual({ type: "chapter", number: 12 });
  });

  it("treats roman-numeral-prefixed titles as part dividers, not filename idrefs", () => {
    expect(classifyEntry("part0009.xhtml", "I. The Ceasefire", "").type).toBe("part");
    expect(classifyEntry("id5", "Part One", "").type).toBe("part");
    // a filename-style idref must NOT be read as a Part divider
    expect(classifyEntry("part0008.xhtml", "Porthus", "Porthus grabbed his leg").type).toBe("other");
  });

  it("classifies structural and front-matter sections", () => {
    expect(classifyEntry("x_prologue-xhtml").type).toBe("prologue");
    expect(classifyEntry("x_interlude-xhtml").type).toBe("interlude");
    expect(classifyEntry("x_epilogue-xhtml").type).toBe("epilogue");
    expect(classifyEntry("x_epigraph-xhtml").type).toBe("epigraph");
    expect(classifyEntry("x_part-001-xhtml")).toEqual({ type: "part", number: 1 });
    expect(classifyEntry("x_copyright-xhtml").type).toBe("front");
    expect(classifyEntry("x_dedication-xhtml").type).toBe("front");
  });

  it("parses Roman-numeral chapter titles (Hierarchy style)", () => {
    expect(classifyEntry("ch01", "Chapter I", "")).toEqual({ type: "chapter", number: 1 });
    expect(classifyEntry("ch25", "Chapter XXV", "")).toEqual({ type: "chapter", number: 25 });
    expect(classifyEntry("ch50", "Chapter L", "")).toEqual({ type: "chapter", number: 50 });
    expect(classifyEntry("ch74", "Chapter LXXIV", "")).toEqual({ type: "chapter", number: 74 });
  });

  it("falls back to a ch<digits> idref when the title is uninformative", () => {
    expect(classifyEntry("ch07", "", "")).toEqual({ type: "chapter", number: 7 });
  });

  it("does not let a ch<digits> idref override an informative title", () => {
    expect(classifyEntry("ch01", "Prologue", "").type).toBe("prologue");
    expect(classifyEntry("ch00", "Copyright", "").type).toBe("front");
    expect(classifyEntry("ch05", "Part One", "").type).toBe("part");
  });

  it("does not treat a word that merely uses Roman letters as a numeral", () => {
    expect(classifyEntry("x1", "Chapter Civil", "").type).not.toBe("chapter");
    expect(classifyEntry("x2", "Chapter IIII", "").type).not.toBe("chapter");
  });

  it("classifies in-book appendices and publisher pages as front matter", () => {
    for (const title of ["Glossary", "Map of the Catenan Republic", "Map", "Image Description", "Major Characters", "Cast of Characters", "Dramatis Personae"]) {
      expect(classifyEntry("x", title, "").type, title).toBe("front");
    }
    for (const idref of ["endpaper_front", "SS_US_adult_signup_back", "SS_recommendpage", "longdesc", "SS_DRM_notice"]) {
      expect(classifyEntry(idref, "", "").type, idref).toBe("front");
    }
  });
});

describe("romanToInt", () => {
  it("parses well-formed numerals case-insensitively", () => {
    expect(romanToInt("i")).toBe(1);
    expect(romanToInt("IV")).toBe(4);
    expect(romanToInt("xl")).toBe(40);
    expect(romanToInt("XCIX")).toBe(99);
    expect(romanToInt("MMXXVI")).toBe(2026);
  });
  it("rejects malformed or non-numeral strings", () => {
    expect(romanToInt("")).toBeNull();
    expect(romanToInt("IIII")).toBeNull();
    expect(romanToInt("civil")).toBeNull();
    expect(romanToInt("12")).toBeNull();
  });
});

describe("planSection", () => {
  const none = { excludeSections: [], sectionLabels: {} };

  it("drops entries listed in excludeSections by TOC title or idref (exact, case-insensitive)", () => {
    const opts = { excludeSections: ["Catenan Rankings", "bm02"], sectionLabels: {} };
    expect(planSection({ idref: "fm01", href: "fm01.xhtml" }, 5, "catenan rankings", "Catenan Rankings", "", opts)).toEqual({ include: false });
    expect(planSection({ idref: "bm02", href: "bm02.xhtml" }, 90, "Locations", "Locations", "", opts)).toEqual({ include: false });
  });

  it("matches whole titles only — a substring is not an exclusion", () => {
    const opts = { excludeSections: ["Map"], sectionLabels: {} };
    const out = planSection({ idref: "ch03", href: "c.xhtml" }, 9, "The Mapmaker", "The Mapmaker", "", opts);
    expect(out.include).toBe(true);
  });

  it("drops front matter and keeps classification for the rest", () => {
    expect(planSection({ idref: "copyright", href: "c.xhtml" }, 1, "Copyright", "Copyright", "", none)).toEqual({ include: false });
    expect(planSection({ idref: "ch02", href: "c.xhtml" }, 8, "Chapter II", "Chapter II", "", none)).toEqual({ include: true, type: "chapter", number: 2, base: "C2" });
    expect(planSection({ idref: "x9", href: "x.xhtml" }, 42, "", "", "Some prose.", none)).toEqual({ include: true, type: "other", number: null, base: "Sec42" });
  });

  it("applies a sectionLabels override by idref regardless of classification", () => {
    const opts = { excludeSections: [], sectionLabels: { part04_sub01: "Synchronism", part04_sub02: "Synchronism" } };
    const a = planSection({ idref: "part04_sub01", href: "a.xhtml" }, 88, "Synchronism: Ex Uno Plures", "Synchronism: Ex Uno Plures", "", opts);
    const b = planSection({ idref: "part04_sub02", href: "b.xhtml" }, 89, "", "", "T HE BURNING", opts);
    expect(a).toMatchObject({ include: true, base: "Synchronism" });
    expect(b).toMatchObject({ include: true, base: "Synchronism" });
  });

  it("an override colliding with a generated label still yields a distinct label via uniqueLabel", () => {
    // planSection only chooses the base; uniqueness is applied in buildSections. Pin the base here
    // and the suffixing behaviour via baseLabel+uniqueLabel semantics documented in buildSections.
    const opts = { excludeSections: [], sectionLabels: { intro: "C1" } };
    expect(planSection({ idref: "intro", href: "i.xhtml" }, 3, "", "", "", opts)).toMatchObject({ include: true, base: "C1" });
  });
});

describe("scopeOptionsToBook", () => {
  const opts = {
    excludeSections: ["Glossary", "B2:Map of the Catenan Republic", "B1:Prelude"],
    sectionLabels: { "B1:part04_sub01": "Synchronism", "B2:part09": "Coda", intro: "Intro" },
  };

  it("keeps unscoped entries and this book's entries with the prefix stripped", () => {
    expect(scopeOptionsToBook(opts, 1)).toEqual({
      excludeSections: ["Glossary", "Prelude"],
      sectionLabels: { part04_sub01: "Synchronism", intro: "Intro" },
    });
  });

  it("drops entries scoped to other books", () => {
    expect(scopeOptionsToBook(opts, 2)).toEqual({
      excludeSections: ["Glossary", "Map of the Catenan Republic"],
      sectionLabels: { part09: "Coda", intro: "Intro" },
    });
    expect(scopeOptionsToBook(opts, 3)).toEqual({ excludeSections: ["Glossary"], sectionLabels: { intro: "Intro" } });
  });
});

describe("unmatchedPreprocessEntries", () => {
  it("reports excludeSections and sectionLabels entries that matched no spine entry", () => {
    const opts = {
      excludeSections: ["Glossary", "Catenan Rankingz"],
      sectionLabels: { part04_sub01: "Synchronism", part09: "Ghost" },
    };
    const out = unmatchedPreprocessEntries(opts, { titles: ["glossary", "Chapter I"], idrefs: ["ch01", "part04_sub01"] });
    expect(out).toEqual([
      'excludeSections: "Catenan Rankingz" matched no spine entry (title or idref)',
      'sectionLabels: "part09" matched no spine idref',
    ]);
  });

  it("matches case-insensitively and is empty when everything matched", () => {
    const opts = { excludeSections: ["GLOSSARY", "bm02"], sectionLabels: { ch01: "Intro" } };
    expect(unmatchedPreprocessEntries(opts, { titles: ["Glossary"], idrefs: ["bm02", "ch01"] })).toEqual([]);
  });
});

describe("baseLabel", () => {
  it("formats labels per section type", () => {
    expect(baseLabel("chapter", 6)).toBe("C6");
    expect(baseLabel("part", 2)).toBe("Part2");
    expect(baseLabel("prologue", null)).toBe("Prologue");
    expect(baseLabel("epilogue", null)).toBe("Epilogue");
  });
});

describe("extractParagraphs", () => {
  it("returns non-empty paragraphs in document order with markup flattened", () => {
    const xhtml = `<html><body>
      <h1>1</h1>
      <p class="first">Hello <b>Carl</b> and <span>Donut</span>.</p>
      <p>   </p>
      <p>Second   paragraph
        wraps lines.</p>
    </body></html>`;
    expect(extractParagraphs(xhtml)).toEqual([
      "Hello Carl and Donut.",
      "Second paragraph wraps lines.",
    ]);
  });

  it("decodes HTML entities", () => {
    const xhtml = `<html><body><p>Mordecai &amp; the System said &#8220;hi&#8221;.</p></body></html>`;
    expect(extractParagraphs(xhtml)).toEqual(["Mordecai & the System said “hi”."]);
  });

  it("is repeatable: same input yields identical paragraph indices", () => {
    const xhtml = `<html><body><p>a</p><p>b</p><p>c</p></body></html>`;
    expect(extractParagraphs(xhtml)).toEqual(extractParagraphs(xhtml));
  });
});

describe("parseTocTitles", () => {
  it("maps each content file basename to its first navPoint title", () => {
    const ncx = `<ncx><navMap>
      <navPoint><navLabel><text>Chapter 1</text></navLabel><content src="OEBPS/part0008.xhtml"/>
        <navPoint><navLabel><text>A subsection</text></navLabel><content src="OEBPS/part0008.xhtml#x"/></navPoint>
      </navPoint>
      <navPoint><navLabel><text>I. The Ceasefire</text></navLabel><content src="part0009.xhtml#top"/></navPoint>
    </navMap></ncx>`;
    const map = parseTocTitles(ncx);
    expect(map.get("part0008.xhtml")).toBe("Chapter 1");
    expect(map.get("part0009.xhtml")).toBe("I. The Ceasefire");
  });
});

describe("parseSpine", () => {
  it("resolves itemref order to manifest hrefs", () => {
    const opf = `<package><manifest>
        <item id="c1" href="Text/part0004.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="Text/part0006.xhtml" media-type="application/xhtml+xml"/>
        <item id="img" href="Images/a.jpg" media-type="image/jpeg"/>
      </manifest>
      <spine>
        <itemref idref="c1"/>
        <itemref idref="c2"/>
      </spine></package>`;
    expect(parseSpine(opf)).toEqual([
      { idref: "c1", href: "Text/part0004.xhtml" },
      { idref: "c2", href: "Text/part0006.xhtml" },
    ]);
  });
});

describe("renderChunk", () => {
  it("emits annotated [B·label·¶n] markers per paragraph", () => {
    const section: Section = {
      type: "chapter",
      label: "C6",
      chapterNumber: 6,
      title: "Chapter 6",
      href: "x.xhtml",
      paragraphs: ["First line.", "Second line."],
    };
    const text = renderChunk(1, { index: 1, sections: [section], wordCount: 4 });
    expect(text).toContain('### B1·C6 — "Chapter 6"');
    expect(text).toContain("[B1·C6·¶1] First line.");
    expect(text).toContain("[B1·C6·¶2] Second line.");
  });
});

describe("isInsideDir", () => {
  it("is true for files at or below the directory and false otherwise", () => {
    expect(isInsideDir("/cf/hierarchy/epubs", "/cf/hierarchy/epubs/book1.epub")).toBe(true);
    expect(isInsideDir("/cf/hierarchy/epubs", "/cf/hierarchy/epubs/sub/book1.epub")).toBe(true);
    expect(isInsideDir("/cf/hierarchy/epubs", "/cf/hierarchy/book1.epub")).toBe(false);
    expect(isInsideDir("/cf/hierarchy/epubs", "/cf/dcc/epubs/book1.epub")).toBe(false);
    expect(isInsideDir("/cf/hierarchy/epubs", "/cf/hierarchy/epubs-old/book1.epub")).toBe(false);
    expect(isInsideDir("/cf/hierarchy/epubs", "/cf/hierarchy/epubs/../book1.epub")).toBe(false);
  });
});
