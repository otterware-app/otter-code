import { createContext, useContext } from "react";

/** Retained module pages keep their UI, but only the visible page owns shell context and shortcuts. */
export const SuitePageActivity = createContext(true);
export const useSuitePageActive = () => useContext(SuitePageActivity);
