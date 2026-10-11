import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateWallSeries,
  createWallDisplayMetrics,
  formatWallAge,
  formatWallMeters,
  formatWallValue,
  linkQualityScore,
  nearestWallHazard,
  perClassStatistics,
  rankNearestHazards,
  shareFreshHazards,
  wallMapPoint,
  windowedLossPercent,
} from "../frontend/src/lib/wallDisplay.js";
import { DASHBOARD_CONFIG } from "../frontend/src/config.js";

const t0 = 100_000;

function hazard(id, className, ageMs, xCm, sigmaCm, conf = 5) {
  return {
    id,
    class: className,
    x_cm: xCm,
    y_cm: 0,
    conf,
    sigma_cm: sigmaCm,
    age_ms: ageMs,
    receivedAt: t0,
  };
}

test("link quality subtracts windowed loss and configured packet-age penalty", () => {
  assert.equal(
    linkQualityScore(20, 5000),
    100 - 20 - 5 * DASHBOARD_CONFIG.wallDisplay.qualityAgePenaltyPointsPerSecond,
  );
  assert.equal(linkQualityScore(120, 0), 0);
  assert.equal(linkQualityScore(null, 0), null);
});

test("fresh hazard share uses current local age and avoids empty placeholders", () => {
  const hazards = [
    hazard("fresh", "ice", 1000, 10, 20),
    hazard("aging", "rock", 7000, 20, 30),
  ];
  assert.equal(shareFreshHazards(hazards, t0), 50);
  assert.equal(shareFreshHazards([], t0), null);
  assert.equal(shareFreshHazards([{ age_ms: 0 }], t0), null);
});

test("per-class statistics calculate count, confidence, sigma, oldest age and nearest range", () => {
  const hazards = [
    hazard("ice-1", "ice", 1000, 300, 40, 6),
    hazard("ice-2", "ice", 9000, 100, 60, 4),
    hazard("crater-1", "crater", 3000, 700, 100, 5),
  ];
  const rows = perClassStatistics(hazards, t0, { x_cm: 0, y_cm: 0 });
  const ice = rows.find((row) => row.value === "ice");
  const crater = rows.find((row) => row.value === "crater");
  const total = rows.find((row) => row.value === "total");

  assert.equal(ice.count, 2);
  assert.equal(ice.averageConfidence, 5);
  assert.equal(ice.averageSigmaCm, 50);
  assert.equal(ice.oldestAgeMs, 9000);
  assert.equal(ice.nearestDistanceCm, 100);
  assert.equal(crater.count, 1);
  assert.equal(total.count, 3);
  assert.equal(total.averageSigmaCm, 200 / 3);
  assert.equal(perClassStatistics([], t0)[0].count, null);
});

test("nearest hazard ranking is ascending, bounded and omits unavailable ranges", () => {
  const hazards = [
    hazard("far", "ice", 0, 800, 0),
    hazard("near", "rock", 0, 100, 0),
    { ...hazard("no-position", "crater", 0, 0, 0), x_cm: null },
  ];
  assert.deepEqual(
    rankNearestHazards(hazards, { x_cm: 0, y_cm: 0 }, 1).map(
      ({ hazard: item, distanceCm }) => [item.id, distanceCm],
    ),
    [["near", 100]],
  );
  assert.deepEqual(rankNearestHazards(hazards, null), []);
});

test("wall map projects east/north coordinates through the shared zoom and pan", () => {
  assert.deepEqual(
    wallMapPoint(
      { x_cm: 100, y_cm: 200 },
      { width: 800, height: 600, zoom: 2, panX: 0.1, panY: -0.1 },
      0.08,
    ),
    { x: 496, y: 208 },
  );
  assert.equal(
    wallMapPoint(
      { x_cm: Number.NaN, y_cm: 0 },
      { width: 800, height: 600, zoom: 1, panX: 0, panY: 0 },
      0.08,
    ),
    null,
  );
});

test("wall map marker hit testing selects the nearest rendered hazard", () => {
  const near = { id: "near" };
  assert.equal(
    nearestWallHazard(
      [
        { hazard: { id: "far" }, screenX: 120, screenY: 100 },
        { hazard: near, screenX: 104, screenY: 102 },
      ],
      { x: 100, y: 100 },
      10,
    ),
    near,
  );
  assert.equal(
    nearestWallHazard([{ hazard: near, screenX: 104, screenY: 102 }], { x: 0, y: 0 }, 10),
    null,
  );
});

test("windowed loss uses expected and received deltas, not cumulative loss_pct", () => {
  const history = [
    { time: t0 - 11_000, expected: 10, received: 10, lossPct: 0 },
    { time: t0 - 9000, expected: 30, received: 28, lossPct: 99 },
    { time: t0 - 1000, expected: 50, received: 44, lossPct: 0 },
  ];
  assert.equal(windowedLossPercent(history, t0), 20);
  assert.equal(windowedLossPercent(history.slice(0, 1), t0), null);
});

test("windowed series aggregates loss, bytes/s, detections/minute and mean sigma", () => {
  const samples = [
    {
      time: t0 - 60_000,
      expected: 10,
      received: 10,
      bytesRx: 1000,
      detections: 2,
      sigmaCm: 20,
    },
    {
      time: t0 - 30_000,
      expected: 30,
      received: 26,
      bytesRx: 4000,
      detections: 1,
      sigmaCm: 40,
    },
    {
      time: t0,
      expected: 50,
      received: 44,
      bytesRx: 7000,
      detections: 3,
      sigmaCm: 60,
    },
  ];
  const series = aggregateWallSeries(samples, t0, 60_000, 60_000);
  assert.equal(series.length, 1);
  assert.equal(series[0].lossPercent, 15);
  assert.equal(series[0].bytesPerSecond, 100);
  assert.equal(series[0].detectionsPerMinute, 6);
  assert.equal(series[0].meanSigmaCm, 40);
  assert.deepEqual(aggregateWallSeries([], t0, 60_000, 60_000).map(
    ({ lossPercent, bytesPerSecond, detectionsPerMinute, meanSigmaCm }) =>
      [lossPercent, bytesPerSecond, detectionsPerMinute, meanSigmaCm],
  ), [[null, null, null, null]]);
});

test("empty snapshot metrics expose unavailable values without numeric defaults", () => {
  const metrics = createWallDisplayMetrics({
    hazards: [],
    history: [],
    link: { expected: 0, received: 0 },
    now: t0,
    lastPacketAgeMs: null,
  });
  assert.equal(metrics.hasHazards, false);
  assert.deepEqual(metrics.gauges, {
    deliveryPercent: null,
    windowedLossPercent: null,
    freshSharePercent: null,
    linkQualityPercent: null,
  });
  assert.ok(Object.values(metrics.hazardClassCounts).every((value) => value === null));
  assert.ok(Object.values(metrics.stageCounts).every((value) => value === null));
  assert.ok(
    metrics.statistics.every(
      (row) =>
        row.count === null &&
        row.averageConfidence === null &&
        row.averageSigmaCm === null &&
        row.oldestAgeMs === null &&
        row.nearestDistanceCm === null,
    ),
  );
  assert.equal(formatWallValue(null), "no data");
  assert.equal(formatWallAge(null), "no data");
  assert.equal(formatWallMeters(null), "no data");
  assert.equal(Number.isNaN(formatWallValue(Number.NaN)), false);
});
