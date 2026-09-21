const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

const project = (template: unknown, source: unknown, missingAsNull: boolean): unknown => {
  if (source === undefined) return missingAsNull ? null : template;
  if (source === null) return null;
  if (Array.isArray(template) && Array.isArray(source)) {
    return template.length ? source.map(item => project(template[0], item, missingAsNull)) : [...source];
  }
  if (isPlain(template) && isPlain(source)) {
    return Object.fromEntries(
      Object.keys(template)
        .filter(key => !unsafeKeys.has(key))
        .map(key => [key, project(template[key], Object.hasOwn(source, key) ? source[key] : undefined, missingAsNull)])
    );
  }
  return source;
};

/** Whitelists server data by the shape of the initial values; keys the server omitted become null. */
export default function mergeProperties<Values>(initialValues: Values, source: unknown): Values {
  return (source == null ? project(initialValues, initialValues, false) : project(initialValues, source, true)) as Values;
}
