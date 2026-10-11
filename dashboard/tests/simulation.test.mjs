import test from "node:test";
import assert from "node:assert/strict";
import {
  addContactAgeOffset,
  addDisplayAgeOffset,
  clearLinkPreview,
  createScenarioSnapshot,
  scenarioEvents,
  shouldDisplayPreviewSnapshot,
  toDisplayHazards,
} from "../frontend/src/lib/simulation.js";

test("time warp changes display ages and contact timers without mutating source data", () => {
  const hazard = { id: "ice:1", age_ms: 2000, x_cm: 10 };
  const link = { since_last_rx_ms: 3000 };
  const shiftedHazards = addDisplayAgeOffset([hazard], 120_000);
  const shiftedContact = addContactAgeOffset(link, 4000, 120_000);

  assert.equal(shiftedHazards[0].age_ms, 122_000);
  assert.equal(shiftedHazards[0].x_cm, 10);
  assert.equal(shiftedContact.link.since_last_rx_ms, 123_000);
  assert.equal(shiftedContact.snapshotAgeMs, 124_000);
  assert.deepEqual(hazard, { id: "ice:1", age_ms: 2000, x_cm: 10 });
  assert.deepEqual(link, { since_last_rx_ms: 3000 });
});

test("clear-link preview is local and leaves its live link object unchanged", () => {
  const live = {
    expected: 10,
    received: 7,
    lost: 3,
    loss_pct: 30,
    since_last_rx_ms: 5000,
    blackout: true,
  };
  const preview = clearLinkPreview(live);

  assert.deepEqual(preview, {
    ...live,
    received: 10,
    lost: 0,
    loss_pct: 0,
    since_last_rx_ms: 0,
    blackout: false,
  });
  assert.equal(live.loss_pct, 30);
  assert.equal(live.blackout, true);
});

test("the fixed-seed scenario is deterministic and emits contract-shaped snapshots", () => {
  const first = createScenarioSnapshot(90_000);
  const again = createScenarioSnapshot(90_000);

  assert.deepEqual(first, again);
  assert.equal(first.type, "snapshot");
  assert.equal(first.t_ms, 90_000);
  assert.equal(first.hazards.filter(({ class: className }) => className !== "beacon").length, 5);
  assert.equal(first.hazards.at(-1).class, "beacon");
  assert.equal(first.link.blackout, true);
  assert.deepEqual(
    Object.keys(first.link),
    [
      "expected",
      "received",
      "lost",
      "loss_pct",
      "crc_fail",
      "duplicates",
      "reordered",
      "bytes_rx",
      "last_rx_ms",
      "since_last_rx_ms",
      "blackout",
    ],
  );
});

test("scenario conversion isolates its display hazards from live state", () => {
  const liveHazards = [{ id: "live:1", class: "rock", age_ms: 0 }];
  const liveSnapshot = {
    type: "snapshot",
    t_ms: 10_000,
    hazards: [
      { id: "sim:1", class: "ice", x_cm: 10, y_cm: 20, age_ms: 1000 },
      { id: "beacon", class: "beacon", x_cm: 0, y_cm: 0 },
    ],
    link: {},
  };
  const displayHazards = toDisplayHazards(liveSnapshot, 50_000);

  assert.deepEqual(liveHazards, [{ id: "live:1", class: "rock", age_ms: 0 }]);
  assert.equal(displayHazards.length, 1);
  assert.equal(displayHazards[0].id, "sim:1");
  assert.equal(displayHazards[0].receivedAt, 50_000);
  assert.equal(liveSnapshot.hazards[0].receivedAt, undefined);
});

test("the deterministic noisy-link preview drops approximately 30 percent", () => {
  let displayed = 0;
  const total = 10_000;
  for (let sequence = 1; sequence <= total; sequence += 1) {
    if (shouldDisplayPreviewSnapshot(sequence, 30)) displayed += 1;
  }
  const droppedPercent = ((total - displayed) / total) * 100;
  assert.ok(droppedPercent >= 29 && droppedPercent <= 31, `${droppedPercent}% dropped`);
  assert.equal(shouldDisplayPreviewSnapshot(1, 0), true);
  assert.equal(shouldDisplayPreviewSnapshot(1, 100), false);
});

test("scenario events are mission-timed and visibly tagged SIM", () => {
  const events = scenarioEvents(110_000);
  assert.ok(events.some((event) => event.code === "BLACKOUT ON" && event.tMs === 90_000));
  assert.ok(events.some((event) => event.code === "AOS" && event.tMs === 110_000));
  assert.ok(events.every((event) => event.simulated));
});
