import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateBytesPerSecond,
  generateStateEvents,
  trustVerdict,
  uncertaintyBreakdown,
} from "../frontend/src/lib/sidebar.js";
import { parseTelemetryMetricsFile } from "../frontend/src/lib/telemetry.js";

test("uncertainty breakdown combines geometry and age and applies the cap", () => {
  const result = uncertaintyBreakdown({ sigma_cm: 40 }, 40_000);
  assert.equal(result.sigmaCm, 40);
  assert.equal(result.ageCm, 120);
  assert.equal(result.radiusCm, 160);
  assert.equal(result.capped, false);

  const capped = uncertaintyBreakdown({ sigma_cm: 250 }, 20_000);
  assert.equal(capped.radiusCm, 300);
  assert.equal(capped.capped, true);
});

test("trust verdict follows the visible confidence and aging rules", () => {
  assert.equal(trustVerdict(1000, 5).verdict, "RELIABLE");
  assert.equal(trustVerdict(5000, 7).verdict, "VERIFY");
  assert.equal(trustVerdict(1000, 2).verdict, "DO NOT RELY");
  assert.equal(trustVerdict(30_000, 7).verdict, "DO NOT RELY");
});

test("bytes per second uses byte deltas and elapsed time", () => {
  assert.equal(calculateBytesPerSecond(1500, 500, 2000), 500);
  assert.equal(calculateBytesPerSecond(500, 1500, 1000), null);
  assert.equal(calculateBytesPerSecond(10, 0, 0), null);
});

test("optional teammate metrics are measured only when supplied", () => {
  assert.deepEqual(
    parseTelemetryMetricsFile(
      JSON.stringify({ hazards_expected: 8, compression_ratio: 2.4 }),
    ),
    { hazards_expected: 8, compression_ratio: 2.4 },
  );
  assert.deepEqual(parseTelemetryMetricsFile("{}"), {});
  assert.equal(parseTelemetryMetricsFile("{bad json"), null);
});

test("events are generated for state changes and use mission time", () => {
  const initial = {
    connectionState: "connected",
    linkState: "AOS",
    hazardIds: ["old"],
    tMs: 20_000,
    nextId: 3,
  };
  const result = generateStateEvents(initial, {
    connectionState: "connected",
    linkState: "LOS",
    lastContactMs: 12_000,
    tMs: 21_000,
    hazards: [
      { id: "old", class: "rock", x_cm: 0, y_cm: 0 },
      { id: "ice:1", class: "ice", x_cm: 150, y_cm: -200 },
    ],
  });

  assert.deepEqual(
    result.events.map(({ code, tMs }) => [code, tMs]),
    [
      ["LOS", 21_000],
      ["NEW HAZARD ICE", 21_000],
    ],
  );
  assert.deepEqual(result.state.hazardIds, ["old", "ice:1"]);
});
