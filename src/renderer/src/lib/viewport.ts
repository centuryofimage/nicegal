import { MediaQuery } from "svelte/reactivity";

/** Phone-width windows, matching the `max-width: 600px` breakpoint the stylesheets use. */
export const phoneWidth: { readonly current: boolean } =
  typeof window === "undefined" ? { current: false } : new MediaQuery("max-width: 600px");
