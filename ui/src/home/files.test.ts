import { describe, expect, it } from "vitest";
import { dragHasFiles, fileKey, mergeFiles, removeFileAt, totalBytes } from "./files";

const f = (name: string, size: number, lastModified = 1) => ({ name, size, lastModified }) as File;

describe("multi-file selection", () => {
  it("appends new files in order", () => {
    const a = f("a.txt", 1), b = f("b.txt", 2), c = f("c.txt", 3);
    expect(mergeFiles([a], [b, c]).map((x) => x.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
  it("skips a file picked twice, also within the same batch", () => {
    const a = f("a.txt", 1);
    expect(mergeFiles([a], [f("a.txt", 1), f("b.txt", 2), f("b.txt", 2)]).map((x) => x.name)).toEqual(["a.txt", "b.txt"]);
  });
  it("keeps files that share a name but differ in size or date", () => {
    expect(mergeFiles([f("a.txt", 1)], [f("a.txt", 2), f("a.txt", 1, 9)])).toHaveLength(3);
  });
  it("accepts an empty or missing list", () => {
    expect(mergeFiles([f("a", 1)], null)).toHaveLength(1);
    expect(mergeFiles([], [])).toEqual([]);
  });
  it("removes one file by index and totals sizes", () => {
    const list = [f("a", 10), f("b", 20), f("c", 30)];
    expect(removeFileAt(list, 1).map((x) => x.name)).toEqual(["a", "c"]);
    expect(removeFileAt(list, 7)).toHaveLength(3);
    expect(totalBytes(list)).toBe(60);
    expect(fileKey(list[0])).not.toBe(fileKey(list[1]));
  });
  it("only reacts to drags that carry files", () => {
    expect(dragHasFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
});
