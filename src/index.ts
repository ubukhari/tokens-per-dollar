/**
 * tokens-per-dollar as a library: the renderer and the demo. The comparison itself is seatledger's
 * (`planCompare`, and the `seatledger_plan_compare` MCP tool), so the CLI, the tool and any other
 * caller give the same answer.
 */
export { main, type Io } from "./main.js";
export { renderCompare, usd, calendarDay } from "./render.js";
export { runDemo, screenshotText, textToSvg, SYNTHETIC_LABEL, type Demo } from "./demo.js";
export {
  seatledgerHint,
  tpdHome,
  quietFromEnv,
  HINT,
  FORECAST_HANDOFF,
  SEATLEDGER_URL,
} from "./hint.js";
export {
  forecast,
  calibrate,
  creditsOf,
  project,
  PACE_DAYS,
  HIT_LOOKBACK_DAYS,
  type ForecastView,
  type ForecastOptions,
  type CodexForecast,
  type CodexWindow,
  type ClaudeForecast,
  type ClaudeHit,
  type Calibration,
  type Projection,
  type PlanCoverage,
} from "./forecast.js";
export { renderForecast } from "./forecast-render.js";
export {
  runForecastDemo,
  forecastScreenshotText,
  FORECAST_SYNTHETIC_LABEL,
  type ForecastDemo,
} from "./forecast-demo.js";
export {
  loadLimitHits,
  readLimitHits,
  hitFromLine,
  kindFromText,
  dedupeHits,
  type LimitHit,
  type LimitKind,
} from "./claude-limits.js";
export { planCompare, type PlanCompareView } from "seatledger";
