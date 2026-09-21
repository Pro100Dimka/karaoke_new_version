export default (...values: readonly (string | false | null | undefined)[]): string =>
  values.filter(Boolean).join(" ");
