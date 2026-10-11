import { DETECTION_CLASSES, TELEMETRY_CONFIG } from "../config.js";

export { DETECTION_CLASSES, TELEMETRY_CONFIG };

const REQUIRED_LINK_FIELDS = Object.freeze([
  "expected",
  "received",
  "lost",
  "loss_pct",
]);
const INTEGER_LINK_FIELDS = Object.freeze([
  "expected",
  "received",
  "lost",
  "crc_fail",
  "duplicates",
  "reordered",
  "bytes_rx",
]);
const NUMBER_LINK_FIELDS = Object.freeze([
  "last_rx_ms",
  "since_last_rx_ms",
]);
const NUMBER_HAZARD_FIELDS = Object.freeze([
  "sigma_cm",
  "ts_ms",
  "age_ms",
  "since_rx_ms",
  "first_rx_ms",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isIdentifier(value) {
  return (
    (typeof value === "string" && value.length > 0) ||
    isFiniteNumber(value)
  );
}

function fieldError(record, field, path, validator, required = false) {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    return required ? `${path}.${field} is required` : null;
  }
  return validator(record[field]) ? null : `${path}.${field} has an invalid type or value`;
}

function validateLink(link) {
  if (!isRecord(link)) return "snapshot.link must be an object";

  for (const field of REQUIRED_LINK_FIELDS) {
    const validator =
      field === "loss_pct"
        ? (value) => isFiniteNumber(value) && value >= 0 && value <= 100
        : isNonNegativeInteger;
    const error = fieldError(link, field, "snapshot.link", validator, true);
    if (error) return error;
  }

  for (const field of INTEGER_LINK_FIELDS) {
    if (REQUIRED_LINK_FIELDS.includes(field)) continue;
    const error = fieldError(link, field, "snapshot.link", isNonNegativeInteger);
    if (error) return error;
  }

  for (const field of NUMBER_LINK_FIELDS) {
    const error = fieldError(link, field, "snapshot.link", isNonNegativeNumber);
    if (error) return error;
  }

  const blackoutError = fieldError(
    link,
    "blackout",
    "snapshot.link",
    (value) => typeof value === "boolean",
  );
  return blackoutError;
}

function validateHazard(hazard, index) {
  const path = `snapshot.hazards[${index}]`;
  if (!isRecord(hazard)) return `${path} must be an object`;

  const requiredFields = ["id", "class", "x_cm", "y_cm"];
  for (const field of requiredFields) {
    const validator =
      field === "id"
        ? isIdentifier
        : field === "class"
          ? (value) => typeof value === "string"
          : isFiniteNumber;
    const error = fieldError(hazard, field, path, validator, true);
    if (error) return error;
  }

  const confidenceError = fieldError(
    hazard,
    "conf",
    path,
    (value) => Number.isInteger(value) && value >= 0 && value <= 7,
    hazard.class !== "beacon",
  );
  if (confidenceError) return confidenceError;

  for (const field of NUMBER_HAZARD_FIELDS) {
    const error = fieldError(hazard, field, path, isNonNegativeNumber);
    if (error) return error;
  }
  return null;
}

export function parseMessage(raw) {
  let message = raw;
  if (typeof raw === "string") {
    try {
      message = JSON.parse(raw);
    } catch (error) {
      const messageError = `Invalid JSON: ${error.message}`;
      return { ok: false, error: messageError, violations: [messageError] };
    }
  }

  if (!isRecord(message)) {
    const error = "Snapshot message must be an object";
    return { ok: false, error, violations: [error] };
  }
  if (message.type !== TELEMETRY_CONFIG.snapshotType) {
    const error = `Expected type "${TELEMETRY_CONFIG.snapshotType}"`;
    return { ok: false, error, violations: [error] };
  }

  const timeError = fieldError(
    message,
    "t_ms",
    "snapshot",
    isNonNegativeNumber,
    true,
  );
  if (timeError) return { ok: false, error: timeError, violations: [timeError] };
  if (!Array.isArray(message.hazards)) {
    const error = "snapshot.hazards must be an array";
    return { ok: false, error, violations: [error] };
  }
  const linkError = validateLink(message.link);
  if (linkError) return { ok: false, error: linkError, violations: [linkError] };

  const hazards = [];
  const roverSamples = [];
  const violations = [];
  for (let index = 0; index < message.hazards.length; index += 1) {
    const entry = message.hazards[index];
    const error = validateHazard(entry, index);
    if (error) {
      violations.push(error);
      continue;
    }
    if (entry.class === "beacon") roverSamples.push(entry);
    else hazards.push(entry);
  }

  const measuredMetrics = parseOptionalTelemetryMetrics(message);
  const encodedMessage =
    typeof raw === "string" ? raw : JSON.stringify(message);
  const estimatedJsonBytes = new TextEncoder().encode(encodedMessage).length;

  return {
    ok: true,
    snapshot: {
      ...message,
      hazards,
      roverSamples,
      measuredMetrics,
      estimatedJsonBytes,
    },
    violations,
  };
}

function nonNegativeMetric(record, key) {
  return Number.isFinite(record?.[key]) && record[key] >= 0
    ? record[key]
    : undefined;
}

export function parseOptionalTelemetryMetrics(snapshot) {
  const metrics = {};
  for (const key of [
    "hazards_expected",
    "hazards_delivered",
    "bytes_per_second",
    "average_packet_bytes",
    "json_bytes",
    "compression_ratio",
  ]) {
    const value = nonNegativeMetric(snapshot, key);
    if (value !== undefined) metrics[key] = value;
  }
  if (snapshot?.metrics && typeof snapshot.metrics === "object") {
    for (const key of [
      "hazards_expected",
      "hazards_delivered",
      "bytes_per_second",
      "average_packet_bytes",
      "json_bytes",
      "compression_ratio",
    ]) {
      const value = nonNegativeMetric(snapshot.metrics, key);
      if (value !== undefined) metrics[key] = value;
    }
  }
  return metrics;
}

export function parseTelemetryMetricsFile(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  return parseOptionalTelemetryMetrics(value);
}

export function getAge(hazard, receivedAt, now) {
  return (hazard.age_ms ?? 0) + (now - receivedAt);
}

export function ageStage(ageMs) {
  if (ageMs < TELEMETRY_CONFIG.ageMs.aging) return "FRESH";
  if (ageMs < TELEMETRY_CONFIG.ageMs.stale) return "AGING";
  if (ageMs <= TELEMETRY_CONFIG.ageMs.expired) return "STALE";
  return "EXPIRED";
}

export function ageVisuals(className, ageMs) {
  const classColor =
    DETECTION_CLASSES.find((item) => item.value === className)?.color ??
    DETECTION_CLASSES.find((item) => item.value === "unknown").color;
  const ageSeconds = ageMs / 1000;
  const thresholds = TELEMETRY_CONFIG.ageMs;
  const opacity = TELEMETRY_CONFIG.ageOpacity;
  let color = classColor;
  let markerOpacity = opacity.fresh;

  if (ageMs < thresholds.aging) {
    markerOpacity = opacity.fresh;
  } else if (ageMs < thresholds.stale) {
    markerOpacity = opacity.aging;
  } else if (ageMs <= thresholds.expired) {
    color = "#8c9694";
    markerOpacity = opacity.stale;
  } else {
    color = "#8c9694";
    markerOpacity = opacity.expired;
  }

  return { color, opacity: markerOpacity, stage: ageStage(ageMs), ageSeconds };
}

export function uncertaintyComponents(hazard, ageMs, roverPosition = null) {
  const uncertainty = TELEMETRY_CONFIG.uncertainty;
  const ageSeconds = Math.max(0, ageMs) / 1000;
  const measuredSigma = Number.isFinite(hazard?.sigma_cm)
    ? Math.max(0, hazard.sigma_cm)
    : null;
  const hasRoverPosition =
    Number.isFinite(hazard?.x_cm) &&
    Number.isFinite(hazard?.y_cm) &&
    Number.isFinite(roverPosition?.x_cm) &&
    Number.isFinite(roverPosition?.y_cm);
  const distanceFromRover = hasRoverPosition
    ? Math.hypot(
        hazard.x_cm - roverPosition.x_cm,
        hazard.y_cm - roverPosition.y_cm,
      )
    : null;
  const confidence = Number.isFinite(hazard?.conf)
    ? Math.max(0, Math.min(7, hazard.conf))
    : 0;
  const geometryCm =
    measuredSigma ??
    uncertainty.estimatedBaseCm +
      uncertainty.estimatedDistanceFactor *
      (distanceFromRover ?? 0) *
        (1 - confidence / 7);
  const ageCm = uncertainty.kAgeCmPerSecond * ageSeconds;
  const uncappedRadiusCm = geometryCm + ageCm;
  return {
    sigmaCm: measuredSigma,
    geometryCm,
    estimated: measuredSigma === null,
    distanceAvailable: distanceFromRover !== null,
    distanceFromRoverCm: distanceFromRover,
    ageCm,
    ageSeconds,
    radiusCm: Math.min(uncertainty.maxRadiusCm, uncappedRadiusCm),
    capped: uncappedRadiusCm >= uncertainty.maxRadiusCm,
  };
}

export function uncertaintyRadiusCm(hazard, ageSeconds, roverPosition = null) {
  return uncertaintyComponents(hazard, ageSeconds * 1000, roverPosition).radiusCm;
}

export function roverUncertaintyRadiusCm(ageMs) {
  return (
    (TELEMETRY_CONFIG.uncertainty.roverMaxSpeedCmPerSecond *
      Math.max(0, ageMs)) /
    1000
  );
}

export function lastPacketTone(ageMs) {
  if (!Number.isFinite(ageMs)) return "alarm";
  if (ageMs < TELEMETRY_CONFIG.contact.lastPacketNominalBeforeMs) {
    return "nominal";
  }
  if (ageMs <= TELEMETRY_CONFIG.contact.lastPacketWarningBeforeMs) {
    return "warning";
  }
  return "alarm";
}

export function contactState({ serverConnected, lastSnapshotAgeMs, link }) {
  if (!serverConnected) return "SERVER_DISCONNECTED";
  if (!Number.isFinite(lastSnapshotAgeMs) || !link) return "NO_CONTACT";
  if (link.blackout === true) return "BLACKOUT";

  const lastPacketAgeMs = Math.max(
    Number.isFinite(link.since_last_rx_ms) ? link.since_last_rx_ms : 0,
    lastSnapshotAgeMs,
  );
  return lastPacketAgeMs > TELEMETRY_CONFIG.contact.degradedAfterMs
    ? "DEGRADED"
    : "LINKED";
}

export function cmToCanvas(
  xCm,
  yCm,
  originX,
  originY,
  pixelsPerCm = TELEMETRY_CONFIG.map.pixelsPerCm,
) {
  return {
    x: originX + xCm * pixelsPerCm,
    y: originY - yCm * pixelsPerCm,
  };
}

export function canvasToCm(
  canvasX,
  canvasY,
  originX,
  originY,
  pixelsPerCm = TELEMETRY_CONFIG.map.pixelsPerCm,
) {
  return {
    x_cm: (canvasX - originX) / pixelsPerCm,
    y_cm: (originY - canvasY) / pixelsPerCm,
  };
}

export function eventTimeMs(hazard, receivedAt) {
  return receivedAt - (hazard.age_ms ?? 0);
}

export function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "—";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  return `${Math.floor(ageMs / 60_000)}m ago`;
}
