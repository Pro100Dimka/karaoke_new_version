/** Error takes precedence over the hint, as in every field of the kit. */
export default function FieldMessage({
  errorId,
  hintId,
  error,
  hint
}: {
  errorId?: string;
  hintId?: string;
  error?: string;
  hint?: string;
}) {
  if (error) {
    return (
      <small id={errorId} className="ui-field-message" data-error>
        {error}
      </small>
    );
  }
  return hint ? (
    <small id={hintId} className="ui-field-message">
      {hint}
    </small>
  ) : null;
}
