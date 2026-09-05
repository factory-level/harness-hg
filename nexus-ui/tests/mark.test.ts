// The monogram rule has ONE home (primitives/mark) - these pin its
// shape so a card face and a future directory tile can never disagree.
import { describe, expect, test } from "bun:test";
import { abbrOf } from "../src/primitives/mark";

describe("abbrOf", () => {
  test("first letters of the first two words", () => {
    expect(abbrOf("Marketing Manager")).toBe("MM");
    expect(abbrOf("content kanban board")).toBe("CK");
  });
  test("single word takes its first two characters", () => {
    expect(abbrOf("Postiz")).toBe("PO");
    expect(abbrOf("x")).toBe("X");
  });
  test("whitespace is not identity", () => {
    expect(abbrOf("  Higgsfield  ")).toBe("HI");
  });
});
