import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { measureAcousticLatency } from "./acousticLatency";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Each run answers Playing, then Done with the next value (or Failed for NaN).
const runs = (values: number[]) => {
  let run = -1;
  let polled = 0;
  const commands: string[] = [];
  const command = async (name: string) => {
    commands.push(name);
    if (name === "MeasureAcousticLatency") { run += 1; polled = 0; return "Ok"; }
    if (polled++ === 0) return "state=Playing";
    return Number.isNaN(values[run]) ? "state=Failed" : `state=Done|ms=${values[run]}|confidence=0.9`;
  };
  return { command, commands };
};

it("measures the hidden latency the repeated runs agree on and ignores a stray match", async () => {
  const { command, commands } = runs([28, 29, 262]);
  const result = measureAcousticLatency(command);
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBe(29);
  expect(commands.filter((name) => name === "MeasureAcousticLatency")).toHaveLength(3);
});

it("refuses a hidden latency when every run lands somewhere else", async () => {
  const result = measureAcousticLatency(runs([28, 140, 262]).command);
  const failure = expect(result).rejects.toThrow(/disagree/);
  await vi.runAllTimersAsync();
  await failure;
});

it("reports that the microphone heard nothing instead of a number", async () => {
  const result = measureAcousticLatency(runs([NaN, NaN, 30]).command);
  const failure = expect(result).rejects.toThrow(/did not hear/);
  await vi.runAllTimersAsync();
  await failure;
});
