import type { Plugin } from "vite";

/** Where the Library backdrop finds three.js, relative to the page. */
export declare const threeVendorBase: string;
/** Package-relative paths of every three.js file the backdrop's scene imports. */
export declare const threeVendorFiles: () => string[];
/** Serves those files in development and ships them in the build under `threeVendorBase`. */
export declare const threeVendor: () => Plugin;
