import { describe, expect, it } from "vitest";
import {
  baseLabel,
  classifyEntry,
  extractParagraphs,
  parseSpine,
  parseTocTitles,
  renderChunk,
  romanToInt,
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
