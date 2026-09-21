import { useFormik, type FormikConfig } from "formik";

/** Formik with the defaults every form of the application shares: validate on blur, follow new initial values. */
export default function useGetForm<Values extends object>(config: FormikConfig<Values>) {
  return useFormik<Values>({
    enableReinitialize: true,
    validateOnChange: false,
    validateOnBlur: true,
    ...config
  });
}
