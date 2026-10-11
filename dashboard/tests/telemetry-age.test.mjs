import test from "node:test";
import assert from "node:assert/strict";
import {
  ageStage,
  lastPacketTone,
  roverUncertaintyRadiusCm,
  uncertaintyComponents,
} from "../frontend/src/lib/telemetry.js";
import { TELEMETRY_CONFIG } from "../frontend/src/config.js";

test("freshness stages honor every configured boundary", () => {
  const { aging, stale, expired } = TELEMETRY_CONFIG.ageMs;
  assert.equal(ageStage(0), "FRESH");
  assert.equal(ageStage(aging - 1), "FRESH");
  assert.equal(ageStage(aging), "AGING");
  assert.equal(ageStage(stale - 1), "AGING");
  assert.equal(ageStage(stale), "STALE");
  assert.equal(ageStage(expired), "STALE");
  assert.equal(ageStage(expired + 1), "EXPIRED");
});

test("uncertainty grows with data age and is capped", () => {
  const result = uncertaintyComponents({ sigma_cm: 40 }, 40_000);
  assert.equal(result.geometryCm, 40);
  assert.equal(result.ageCm, 120);
  assert.equal(result.radiusCm, 160);
  assert.equal(result.capped, false);

  const capped = uncertaintyComponents({ sigma_cm: 299 }, 1000);
  assert.equal(capped.radiusCm, 300);
  assert.equal(capped.capped, true);
});

test("missing sigma uses configurable rover-relative estimated geometry", () => {
  const result = uncertaintyComponents(
    { x_cm: 300, y_cm: 400, conf: 3 },
    2000,
    { x_cm: 0, y_cm: 0 },
  );
  const { estimatedBaseCm, estimatedDistanceFactor } =
    TELEMETRY_CONFIG.uncertainty;
  const expectedGeometry =
    estimatedBaseCm + estimatedDistanceFactor * 500 * (1 - 3 / 7);

  assert.equal(result.estimated, true);
  assert.equal(result.distanceFromRoverCm, 500);
  assert.equal(result.geometryCm, expectedGeometry);
  assert.equal(result.ageCm, 6);
  assert.equal(result.radiusCm, expectedGeometry + 6);

  const withoutRover = uncertaintyComponents(
    { x_cm: 300, y_cm: 400, conf: 3 },
    0,
  );
  assert.equal(withoutRover.distanceAvailable, false);
  assert.equal(withoutRover.distanceFromRoverCm, null);
  assert.equal(withoutRover.geometryCm, estimatedBaseCm);
});

test("rover uncertainty grows with elapsed time at the configured assumed speed", () => {
  assert.equal(roverUncertaintyRadiusCm(0), 0);
  assert.equal(
    roverUncertaintyRadiusCm(3000),
    TELEMETRY_CONFIG.uncertainty.roverMaxSpeedCmPerSecond * 3,
  );
});

test("last-packet tone changes at the configured boundaries", () => {
  const { lastPacketNominalBeforeMs, lastPacketWarningBeforeMs } =
    TELEMETRY_CONFIG.contact;
  assert.equal(lastPacketTone(lastPacketNominalBeforeMs - 1), "nominal");
  assert.equal(lastPacketTone(lastPacketNominalBeforeMs), "warning");
  assert.equal(lastPacketTone(lastPacketWarningBeforeMs), "warning");
  assert.equal(lastPacketTone(lastPacketWarningBeforeMs + 1), "alarm");
});
