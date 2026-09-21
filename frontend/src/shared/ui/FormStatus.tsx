import { Alert } from "./Alert";

/** Form-level failure (formik.status): shown once under the fields, never repeated under each one. */
export const FormStatus = ({ status }: { status: unknown }) =>
  typeof status === "string" && status ? <Alert intent="error">{status}</Alert> : null;
