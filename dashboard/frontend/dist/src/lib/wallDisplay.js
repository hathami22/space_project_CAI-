import { DASHBOARD_CONFIG, DETECTION_CLASSES } from "../config.js";
import { ageStage, getAge } from "./telemetry.js";

const WALL_CONFIG = DASHBOARD_CONFIG.wallDisplay;
const PERCENT_SCALE = WALL_CONFIG.percentScale;

function finite(value) {
  return Number.isFinite(value);
}

function validPair(first, second) {
  return finite(first) && finite(second);
}

export function windowedLossPercent(history, now, windowMs = WALL_CONFIG.lossWindowMs) {
  if (!Array.isArray(history) || !finite(now) || !finite(windowMs)) return null;
  const samples = history
    .filter((sample) => finite(sample.time) && sample.time >= now - windowMs && sample.time <= now)
    .sort((a, b) => a.time - b.time);
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (
    !finite(first.expected) ||
    !finite(last.expected) ||
    !finite(first.received) ||
    !finite(last.received)
  ) {
    return null;
  }
  const expectedDelta = last.expected - first.expected;
  const receivedDelta = last.received - first.received;
  if (expectedDelta <= 0 || receivedDelta < 0 || receivedDelta > expectedDelta) {
    return null;
  }
  return ((expectedDelta - receivedDelta) / expectedDelta) * PERCENT_SCALE;
}

export function linkQualityScore(lossPercent, lastPacketAgeMs) {
  if (!finite(lossPercent) || !finite(lastPacketAgeMs)) return null;
  const agePenalty =
    (Math.max(0, lastPacketAgeMs) / WALL_CONFIG.millisecondsPerSecond) *
    WALL_CONFIG.qualityAgePenaltyPointsPerSecond;
  return Math.max(
    WALL_CONFIG.qualityMinimumScore,
    Math.min(
      WALL_CONFIG.qualityMaximumScore,
      WALL_CONFIG.qualityBaseScore - lossPercent - agePenalty,
    ),
  );
}

export function shareFreshHazards(hazards, now) {
  if (!Array.isArray(hazards) || hazards.length === 0 || !finite(now)) {
    return null;
  }
  const ages = hazards.map((hazard) =>
    finite(hazard.receivedAt) ? getAge(hazard, hazard.receivedAt, now) : null,
  );
  if (!ages.every(finite)) return null;
  const freshCount = ages.filter((age) => ageStage(age) === "FRESH").length;
  return (freshCount / hazards.length) * PERCENT_SCALE;
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function ageText(ageMs) {
  if (!finite(ageMs)) return "no data";
  if (ageMs < WALL_CONFIG.millisecondsPerMinute) {
    return `${Math.floor(ageMs / WALL_CONFIG.millisecondsPerSecond)} s`;
  }
  return `${Math.floor(ageMs / WALL_CONFIG.millisecondsPerMinute)} m`;
}

function distance(hazard, roverPosition) {
  if (
    !validPair(hazard.x_cm, hazard.y_cm) ||
    !validPair(roverPosition?.x_cm, roverPosition?.y_cm)
  ) {
    return null;
  }
  return Math.hypot(
    hazard.x_cm - roverPosition.x_cm,
    hazard.y_cm - roverPosition.y_cm,
  );
}

export function perClassStatistics(hazards, now, roverPosition = null) {
  const source = Array.isArray(hazards) ? hazards : [];
  const rows = DETECTION_CLASSES.map((item) => {
    const items = source.filter((hazard) => hazard.class === item.value);
    const ages = items
      .map((hazard) => getAge(hazard, hazard.receivedAt, now))
      .filter(finite);
    const confidences = items.map((hazard) => hazard.conf).filter(finite);
    const sigmas = items
      .map((hazard) => hazard.sigma_cm)
      .filter((sigma) => finite(sigma) && sigma >= 0);
    const distances = items
      .map((hazard) => distance(hazard, roverPosition))
      .filter(finite);
    return {
      ...item,
      count: source.length ? items.length : null,
      averageConfidence: average(confidences),
      averageSigmaCm: average(sigmas),
      oldestAgeMs: ages.length ? Math.max(...ages) : null,
      nearestDistanceCm: distances.length ? Math.min(...distances) : null,
    };
  });
  const ages = source
    .map((hazard) => finite(now) ? getAge(hazard, hazard.receivedAt, now) : null)
    .filter(finite);
  const confidences = source.map((hazard) => hazard.conf).filter(finite);
  const sigmas = source
    .map((hazard) => hazard.sigma_cm)
    .filter((sigma) => finite(sigma) && sigma >= 0);
  const distances = source
    .map((hazard) => distance(hazard, roverPosition))
    .filter(finite);
  rows.push({
    value: "total",
    label: "Total",
    count: source.length ? source.length : null,
    averageConfidence: average(confidences),
    averageSigmaCm: average(sigmas),
    oldestAgeMs: ages.length ? Math.max(...ages) : null,
    nearestDistanceCm: distances.length ? Math.min(...distances) : null,
  });
  return rows;
}

export function createWallDisplayMetrics({
  hazards,
  history,
  link,
  now,
  lastPacketAgeMs,
  roverPosition,
}) {
  const source = Array.isArray(hazards) ? hazards : [];
  const lossPercent = windowedLossPercent(history, now);
  const deliveryPercent =
    finite(link?.expected) &&
    finite(link?.received) &&
    link.expected > 0 &&
    link.received >= 0 &&
    link.received <= link.expected
      ? (link.received / link.expected) * PERCENT_SCALE
      : null;
  const stageCounts = {
    FRESH: 0,
    AGING: 0,
    STALE: 0,
    EXPIRED: 0,
  };
  const hasAgeData = finite(now) && source.every((hazard) => finite(hazard.receivedAt));
  if (hasAgeData) {
    for (const hazard of source) {
      const age = getAge(hazard, hazard.receivedAt, now);
      const stage = ageStage(age);
      if (Object.prototype.hasOwnProperty.call(stageCounts, stage)) {
        stageCounts[stage] += 1;
      }
    }
  }
  const calculatedClassCounts = Object.fromEntries(
    DETECTION_CLASSES.map(({ value }) => [
      value,
      source.filter((hazard) => hazard.class === value).length,
    ]),
  );
  const hazardClassCounts = source.length
    ? calculatedClassCounts
    : Object.fromEntries(DETECTION_CLASSES.map(({ value }) => [value, null]));
  const freshSharePercent = shareFreshHazards(source, now);
  return {
    hasHazards: source.length > 0,
    gauges: {
      deliveryPercent,
      windowedLossPercent: lossPercent,
      freshSharePercent,
      linkQualityPercent: linkQualityScore(lossPercent, lastPacketAgeMs),
    },
    hazardClassCounts,
    stageCounts: source.length && hasAgeData
      ? stageCounts
      : Object.fromEntries(Object.keys(stageCounts).map((stage) => [stage, null])),
    statistics: perClassStatistics(source, now, roverPosition),
    rows: source.map((hazard) => ({
      hazard,
      ageMs: getAge(hazard, hazard.receivedAt, now),
      distanceCm: distance(hazard, roverPosition),
    })),
  };
}

export function formatWallValue(value, digits = 1) {
  return finite(value) ? value.toFixed(digits) : "no data";
}

export function formatWallAge(ageMs) {
  return ageText(ageMs);
}

export function formatWallMeters(cm, digits = 2) {
  return finite(cm) ? `${(cm / 100).toFixed(digits)} m` : "no data";
}

export function rankNearestHazards(
  hazards,
  roverPosition,
  limit = WALL_CONFIG.nearestHazardLimit,
) {
  if (!Array.isArray(hazards) || !finite(limit) || limit <= 0) return [];
  return hazards
    .map((hazard) => ({ hazard, distanceCm: distance(hazard, roverPosition) }))
    .filter((entry) => finite(entry.distanceCm))
    .sort((a, b) => a.distanceCm - b.distanceCm)
    .slice(0, Math.floor(limit));
}

export function wallMapPoint(point, viewport, pixelsPerCm) {
  if (
    !validPair(point?.x_cm, point?.y_cm) ||
    !validPair(viewport?.width, viewport?.height) ||
    !validPair(viewport?.zoom, pixelsPerCm) ||
    !validPair(viewport?.panX, viewport?.panY)
  ) {
    return null;
  }
  const scale = pixelsPerCm * viewport.zoom;
  return {
    x: viewport.width / 2 + viewport.panX * viewport.width + point.x_cm * scale,
    y: viewport.height / 2 + viewport.panY * viewport.height - point.y_cm * scale,
  };
}

export function nearestWallHazard(hazards, point, radiusPx) {
  if (
    !Array.isArray(hazards) ||
    !validPair(point?.x, point?.y) ||
    !finite(radiusPx) ||
    radiusPx < 0
  ) {
    return null;
  }
  let nearest = null;
  let nearestDistance = radiusPx;
  for (const hazard of hazards) {
    if (!validPair(hazard.screenX, hazard.screenY)) continue;
    const candidateDistance = Math.hypot(
      hazard.screenX - point.x,
      hazard.screenY - point.y,
    );
    if (candidateDistance <= nearestDistance) {
      nearest = hazard.hazard;
      nearestDistance = candidateDistance;
    }
  }
  return nearest;
}

export function aggregateWallSeries(
  snapshots,
  now,
  windowMs = WALL_CONFIG.seriesWindowMs,
  bucketMs = WALL_CONFIG.seriesBucketMs,
) {
  if (
    !Array.isArray(snapshots) ||
    !finite(now) ||
    !finite(windowMs) ||
    windowMs <= 0 ||
    !finite(bucketMs) ||
    bucketMs <= 0
  ) {
    return [];
  }
  const start = now - windowMs;
  const samples = snapshots
    .filter((sample) => finite(sample.time) && sample.time >= start && sample.time <= now)
    .sort((a, b) => a.time - b.time);
  const bucketCount = Math.ceil(windowMs / bucketMs);
  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = start + index * bucketMs;
    const bucketEnd = Math.min(now, bucketStart + bucketMs);
    const bucketSamples = samples.filter(
      (sample) =>
        sample.time >= bucketStart &&
        (index === bucketCount - 1
          ? sample.time <= bucketEnd
          : sample.time < bucketEnd),
    );
    const first = bucketSamples[0];
    const last = bucketSamples[bucketSamples.length - 1];
    const expectedDelta =
      first && last && finite(first.expected) && finite(last.expected)
        ? last.expected - first.expected
        : null;
    const receivedDelta =
      first && last && finite(first.received) && finite(last.received)
        ? last.received - first.received
        : null;
    const bytesDelta =
      first && last && finite(first.bytesRx) && finite(last.bytesRx)
        ? last.bytesRx - first.bytesRx
        : null;
    const elapsedMs = last && first ? last.time - first.time : 0;
    const binDurationMs = bucketEnd - bucketStart;
    const sigmaValues = bucketSamples
      .map((sample) => sample.sigmaCm)
      .filter((value) => finite(value) && value >= 0);
    const detectionCount = bucketSamples.reduce(
      (sum, sample) =>
        sum + (finite(sample.detections) && sample.detections >= 0 ? sample.detections : 0),
      0,
    );
    return {
      startMs: bucketStart,
      endMs: bucketEnd,
      lossPercent:
        expectedDelta !== null &&
        receivedDelta !== null &&
        expectedDelta > 0 &&
        receivedDelta >= 0 &&
        receivedDelta <= expectedDelta
          ? ((expectedDelta - receivedDelta) / expectedDelta) * PERCENT_SCALE
          : null,
      bytesPerSecond:
        bytesDelta !== null && bytesDelta >= 0 && elapsedMs > 0
          ? (bytesDelta * 1000) / elapsedMs
          : null,
      detectionsPerMinute:
        bucketSamples.some((sample) => finite(sample.detections)) &&
        binDurationMs > 0
          ? (detectionCount * WALL_CONFIG.millisecondsPerMinute) / binDurationMs
          : null,
      meanSigmaCm: average(sigmaValues),
    };
  });
}
