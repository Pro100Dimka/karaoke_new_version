import { expect, it } from "vitest";
import { queueWith } from "./karaokeTv";

const song = (id: string) => ({ id, title: id });

it("puts a song at the end of the TV queue, or first to play right away, never twice", () => {
  const queue = [song("a"), song("b")];
  expect(queueWith(queue, song("c"), "next").map((item) => item.id)).toEqual(["a", "b", "c"]);
  expect(queueWith(queue, song("c"), "now").map((item) => item.id)).toEqual(["c", "a", "b"]);
  expect(queueWith(queue, song("a"), "next").map((item) => item.id)).toEqual(["b", "a"]);
  expect(queueWith(queue, song("b"), "now").map((item) => item.id)).toEqual(["b", "a"]);
});
