import test from "node:test";
import assert from "node:assert/strict";
import { cleanTranslationOutput } from "../src/providers/mizan/MizanTranslation";

const cases: Array<[string, string]> = [
  ["<think>r</think><translate>Hello</translate>", "Hello"],
  ["<think>r</think><translate>Hello", "Hello"],
  ["<think>r</think>Hello", "Hello"],
  ["<think>reasoning cut off mid", ""],
  ["Hello</translate>", "Hello"],
  ['Translation: "Hello"', "Hello"],
  ["<think>only thinking</think>", ""],
  ["<THINK>a</THINK>Hi <think>b</think>there", "Hi there"],
  ["[TRANSLATE]Hello[/TRANSLATE]", "Hello"],
  ["plain", "plain"],
];

for (const [input, expected] of cases) {
  test(`clean: ${input}`, () => {
    assert.equal(cleanTranslationOutput(input), expected);
  });
}
