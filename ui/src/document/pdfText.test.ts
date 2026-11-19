import { describe, expect, it } from "vitest";
import { itemsToLines, linesToParagraphs } from "./pdfText";

const item = (str: string, x: number, y: number, h = 10, hasEOL = false) => ({ str, transform: [h, 0, 0, h, x, y], height: h, hasEOL });

describe("PDF text extraction", () => {
  it("joins items of a baseline and splits paragraphs on larger gaps", () => {
    const lines = itemsToLines([item("Bonjour", 50, 700), item("le monde", 100, 700, 10, true), item("suite du para-", 50, 688, 10, true), item("graphe.", 50, 676, 10, true), item("Nouveau", 50, 640, 10, true), item("Titre", 50, 600, 18, true)]);
    expect(lines.map((l) => l.text)).toEqual(["Bonjour le monde", "suite du para-", "graphe.", "Nouveau", "Titre"]);
    expect(linesToParagraphs(lines)).toEqual(["Bonjour le monde suite du paragraphe.", "Nouveau", "Titre"]);
  });
});
