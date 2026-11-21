// Default/legacy config kept unit-safe: raw `npx vitest` must never start the
// destructive integration globalSetup. The authoritative unit config lives in
// vitest.unit.config.ts.
export { default } from "./vitest.unit.config.js";
