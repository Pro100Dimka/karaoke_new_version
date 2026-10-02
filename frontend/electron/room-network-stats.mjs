export function summarizeRoute({ samples, deadlineMs }) {
  const values = samples.filter(Number.isFinite).map(Number).sort((a, b) => a - b);
  const p95Index = values.length === 0 ? 0 : Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1);
  const p95Ms = values.length === 0 ? null : values[p95Index];
  return {
    samples: values.length,
    minMs: values.length === 0 ? null : values[0],
    maxMs: values.length === 0 ? null : values.at(-1),
    p95Ms,
    deadlineMarginMs: p95Ms === null ? null : deadlineMs - p95Ms,
  };
}
