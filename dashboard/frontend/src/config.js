const defaultWebSocketUrl =
  typeof location === "undefined"
    ? "ws://localhost:8765"
    : `ws://${location.hostname}:8765`;
const webSocketOverride =
  typeof location === "undefined"
    ? null
    : new URLSearchParams(location.search).get("ws");

export const DETECTION_CLASSES = Object.freeze([
  Object.freeze({ value: "crater", label: "Crater", color: "#b68be0" }),
  Object.freeze({ value: "rock", label: "Rock", color: "#f0a04b" }),
  Object.freeze({ value: "ice", label: "Ice", color: "#55d6c2" }),
  Object.freeze({ value: "slope", label: "Slope", color: "#ef6c5b" }),
  Object.freeze({ value: "unknown", label: "Unknown", color: "#a0a9ad" }),
]);

export const DASHBOARD_CONFIG = Object.freeze({
  telemetry: Object.freeze({
    webSocketUrl: webSocketOverride || defaultWebSocketUrl,
    snapshotType: "snapshot",
    clientMessageTypes: Object.freeze({
      setBlackout: "set_blackout",
    }),
    ageMs: Object.freeze({
      aging: 5_000,
      stale: 30_000,
      expired: 120_000,
      remove: 600_000,
    }),
    ageOpacity: Object.freeze({
      fresh: 1,
      aging: 0.55,
      stale: 0.45,
      expired: 0.2,
    }),
    uncertainty: Object.freeze({
      kAgeCmPerSecond: 3,
      maxRadiusCm: 300,
      estimatedBaseCm: 10,
      estimatedDistanceFactor: 0.05,
      roverMaxSpeedCmPerSecond: 5, // TODO: confirm assumed maximum with the team.
    }),
    contact: Object.freeze({
      degradedAfterMs: 3_000,
      lastPacketNominalBeforeMs: 2_000,
      lastPacketWarningBeforeMs: 10_000,
    }),
    map: Object.freeze({
      pixelsPerCm: 0.08,
      gridSpacingCm: 500,
      minZoom: 0.5,
      maxZoom: 6,
      redrawIntervalMs: 100,
    }),
    replayWindowMs: 5 * 60 * 1000,
    historyWindowMs: 60_000,
    refreshIntervalMs: 250,
    reconnectDelayMs: 1500,
    diagnosticWindowMs: 10_000,
    maxRecordedViolations: 100,
  }),
  wallDisplay: Object.freeze({
    designWidth: 1920,
    designHeight: 1080,
    millisecondsPerSecond: 1000,
    millisecondsPerMinute: 60_000,
    millisecondsPerHour: 3_600_000,
    derivedRefreshMs: 1000,
    lossWindowMs: 10_000,
    percentScale: 100,
    qualityBaseScore: 100,
    qualityMinimumScore: 0,
    qualityMaximumScore: 100,
    qualityAgePenaltyPointsPerSecond: 2,
    seriesWindowMs: 5 * 60 * 1000,
    longSeriesWindowMs: 10 * 60 * 1000,
    seriesBucketMs: 30_000,
    nearestHazardLimit: 8,
    f11HintDurationMs: 8000,
    simulationQueryParam: "sim",
    schematic: Object.freeze({
      width: 520,
      height: 380,
      rangeRingsMeters: Object.freeze([5, 10, 20]),
      viewRangeMeters: 20,
      centerY: 235,
      rangeRadiusPx: 140,
      callout: Object.freeze({
        xOffset: 202,
        y: 14,
        width: 190,
        height: 92,
      }),
    }),
    map: Object.freeze({
      background: "#071426",
      grid: "rgba(74, 132, 190, 0.22)",
      rangeRing: "rgba(53, 201, 255, 0.28)",
      roverUncertaintyFill: "rgba(53, 201, 255, 0.08)",
      roverUncertaintyStroke: "rgba(53, 201, 255, 0.7)",
      markerRadiusPx: 6,
      selectedRadiusPx: 11,
      hitRadiusPx: 16,
      gridLabelIntervalCm: 1000,
      pathFadeMs: 30_000,
    }),
  }),
});

export const TELEMETRY_CONFIG = DASHBOARD_CONFIG.telemetry;

export const SCENARIO_CHECKLIST = Object.freeze([
  "Show the live map",
  "Select a hazard and read its uncertainty breakdown",
  "Kill the link",
  "Wait for LOS and watch the uncertainty circles grow",
  "Restore the link",
  "Show the bandwidth budget",
]);

export const PROPOSED_SET_LINK_MESSAGE = Object.freeze({
  type: "set_link",
  loss_pct: 30,
  delay_ms: 0,
});
