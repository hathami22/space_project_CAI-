export const SIMULATION_DURATION_MS = 180_000;
export const TIME_WARP_MAX_SECONDS = 300;

const HAZARD_CLASSES = Object.freeze([
  "crater",
  "rock",
  "ice",
  "unknown",
  "crater",
  "rock",
  "ice",
  "unknown",
]);

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function hazardDefinitions() {
  const random = seededRandom(0x43524154);
  return HAZARD_CLASSES.map((className, index) => {
    const xCm = Math.round((random() * 2 - 1) * 2400);
    const yCm = Math.round((random() * 2 - 1) * 2400);
    const appearsAtMs = [8000, 22000, 39000, 57000, 74000, 128000, 148000, 165000][index];
    const roverAtDetection = roverPosition(appearsAtMs);
    return {
      id: `${className}:${Math.round(xCm / 100)}:${Math.round(yCm / 100)}`,
      class: className,
      x_cm: xCm,
      y_cm: yCm,
      sigma_cm: Math.round(
        15 +
          Math.hypot(
            xCm - roverAtDetection.x_cm,
            yCm - roverAtDetection.y_cm,
          ) *
            0.012,
      ),
      conf: Math.floor(random() * 8),
      appearsAtMs,
    };
  });
}

function roverPosition(timeMs) {
  const seconds = timeMs / 1000;
  return {
    x_cm: Math.round(seconds * 12),
    y_cm: Math.round(Math.sin(seconds / 12) * 220),
  };
}

export function createScenarioSnapshot(timeMs) {
  const tMs = Math.max(0, Math.min(SIMULATION_DURATION_MS, Math.floor(timeMs)));
  const elapsedSeconds = Math.floor(tMs / 1000);
  const blackout = tMs >= 90_000 && tMs < 110_000;
  const expected = elapsedSeconds + 1;
  const lossPct = blackout ? 100 : 2 + ((elapsedSeconds * 17) % 24);
  const lost = Math.round((expected * lossPct) / 100);
  const received = blackout ? 0 : expected - lost;
  const lastRxMs = blackout ? 90_000 : tMs;
  const rover = roverPosition(tMs);
  const hazards = hazardDefinitions()
    .filter((hazard) => hazard.appearsAtMs <= tMs)
    .map((hazard) => ({
      id: hazard.id,
      class: hazard.class,
      conf: hazard.conf,
      x_cm: hazard.x_cm,
      y_cm: hazard.y_cm,
      sigma_cm: hazard.sigma_cm,
      ts_ms: hazard.appearsAtMs,
      age_ms: tMs - hazard.appearsAtMs,
      since_rx_ms: blackout ? tMs - 90_000 : 0,
      first_rx_ms: hazard.appearsAtMs,
    }));

  hazards.push({
    id: "beacon",
    class: "beacon",
    conf: 7,
    ...rover,
    ts_ms: tMs,
    age_ms: 0,
    since_rx_ms: blackout ? tMs - 90_000 : 0,
    first_rx_ms: tMs,
  });

  return {
    type: "snapshot",
    t_ms: tMs,
    hazards,
    link: {
      expected,
      received,
      lost,
      loss_pct: lossPct,
      crc_fail: Math.floor(elapsedSeconds / 37),
      duplicates: Math.floor(elapsedSeconds / 29),
      reordered: Math.floor(elapsedSeconds / 19),
      bytes_rx: received * 72,
      last_rx_ms: lastRxMs,
      since_last_rx_ms: tMs - lastRxMs,
      blackout,
    },
  };
}

export function createScenarioRoverPath(timeMs, receivedAt) {
  const end = Math.max(0, Math.min(SIMULATION_DURATION_MS, Math.floor(timeMs)));
  const points = [];
  for (let tMs = 0; tMs <= end; tMs += 1000) {
    const position = roverPosition(tMs);
    points.push({
      id: "beacon",
      class: "beacon",
      ...position,
      age_ms: end - tMs,
      receivedAt,
      eventTimeMs: receivedAt - (end - tMs),
      identity: `beacon:${tMs}`,
    });
  }
  return points;
}

export function toDisplayHazards(snapshot, receivedAt) {
  return snapshot.hazards
    .filter((hazard) => hazard.class !== "beacon")
    .map((hazard) => ({
      ...hazard,
      receivedAt,
      eventTimeMs: receivedAt - (hazard.age_ms ?? 0),
    }));
}

export function addDisplayAgeOffset(hazards, offsetMs) {
  if (!offsetMs) return hazards;
  return hazards.map((hazard) => ({
    ...hazard,
    age_ms: (hazard.age_ms ?? 0) + offsetMs,
  }));
}

export function addContactAgeOffset(link, snapshotAgeMs, offsetMs) {
  return {
    link: link
      ? {
          ...link,
          since_last_rx_ms: Number.isFinite(link.since_last_rx_ms)
            ? link.since_last_rx_ms + offsetMs
            : link.since_last_rx_ms,
        }
      : null,
    snapshotAgeMs: Number.isFinite(snapshotAgeMs)
      ? snapshotAgeMs + offsetMs
      : snapshotAgeMs,
  };
}

export function clearLinkPreview(link) {
  if (!link) return null;
  return {
    ...link,
    received: link.expected,
    lost: 0,
    loss_pct: 0,
    since_last_rx_ms: 0,
    blackout: false,
  };
}

export function shouldDisplayPreviewSnapshot(sequence, lossPct) {
  if (!Number.isFinite(sequence) || sequence < 1) return false;
  if (!Number.isFinite(lossPct) || lossPct <= 0) return true;
  if (lossPct >= 100) return false;
  const sample = Math.imul(sequence >>> 0, 2654435761) >>> 0;
  return sample / 0x1_0000_0000 >= lossPct / 100;
}

export function scenarioEvents(timeMs) {
  const snapshot = createScenarioSnapshot(timeMs);
  const hazards = snapshot.hazards.filter((hazard) => hazard.class !== "beacon");
  const events = hazards.map((hazard) => ({
    id: `sim-hazard-${hazard.id}`,
    tMs: hazard.first_rx_ms,
    kind: "hazard",
    type: "hazard",
    code: `NEW HAZARD ${hazard.class.toUpperCase()}`,
    message: `${hazard.class} (${(hazard.x_cm / 100).toFixed(2)} m, ${(hazard.y_cm / 100).toFixed(2)} m)`,
    simulated: true,
  }));
  if (timeMs >= 90_000) {
    events.push({
      id: "sim-blackout-on",
      tMs: 90_000,
      kind: "alarm",
      type: "link",
      code: "BLACKOUT ON",
      message: "Simulated 20 s blackout",
      simulated: true,
    });
  }
  if (timeMs >= 110_000) {
    events.push({
      id: "sim-blackout-off",
      tMs: 110_000,
      kind: "nominal",
      type: "link",
      code: "AOS",
      message: "Simulated link recovered",
      simulated: true,
    });
  }
  return events
    .filter((event) => event.tMs <= timeMs)
    .sort((first, second) => second.tMs - first.tMs)
    .slice(0, 100);
}
