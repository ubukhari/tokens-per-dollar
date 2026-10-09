/**
 * tokens-per-dollar as a library: the renderer and the demo. The comparison itself is seatledger's
 * (`planCompare`, and the `seatledger_plan_compare` MCP tool), so the CLI, the tool and any other
 * caller give the same answer.
 */
export { main, type Io } from "./main.js";
export { renderCompare, usd, calendarDay } from "./render.js";
export { runDemo, screenshotText, textToSvg, SYNTHETIC_LABEL, type Demo } from "./demo.js";
export { seatledgerHint, tpdHome, quietFromEnv, HINT, SEATLEDGER_URL } from "./hint.js";
export { planCompare, type PlanCompareView } from "seatledger";
