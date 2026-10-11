import { ageStage, uncertaintyComponents } from "./telemetry.js";

export function uncertaintyBreakdown(hazard, ageMs, roverPosition = null) {
  if (!hazard) return null;
  return uncertaintyComponents(hazard, ageMs, roverPosition);
}

export function trustVerdict(ageMs, confidence) {
  const stage = ageStage(ageMs);
  if (stage === "STALE" || stage === "EXPIRED" || confidence <= 2) {
    return { verdict: "DO NOT RELY", rule: "STALE/EXPIRED or confidence 0-2" };
  }
  if (stage === "AGING" || (confidence >= 3 && confidence <= 4)) {
    return { verdict: "VERIFY", rule: "AGING or confidence 3-4" };
  }
  if (stage === "FRESH" && confidence >= 5) {
    return { verdict: "RELIABLE", rule: "FRESH and confidence 5-7" };
  }
  return { verdict: "VERIFY", rule: "No reliable rule matched" };
}

export function calculateBytesPerSecond(currentBytes, previousBytes, elapsedMs) {
  if (
    !Number.isFinite(currentBytes) ||
    !Number.isFinite(previousBytes) ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    currentBytes < previousBytes
  ) {
    return null;
  }
  return ((currentBytes - previousBytes) * 1000) / elapsedMs;
}

function event(id, tMs, code, message, kind, type) {
  return { id, tMs, code, message, kind, type };
}

export function generateStateEvents(previous, current) {
  const events = [];
  let nextId = previous.nextId ?? 0;
  const add = (code, message, kind, type) => {
    events.push(event(nextId++, current.tMs, code, message, kind, type));
  };

  if (Number.isFinite(previous.tMs) && current.tMs < previous.tMs) {
    add(
      "MISSION CLOCK RESET",
      "Mission clock moved backwards",
      "warning",
      "mission",
    );
  }
  if (previous.connectionState !== null && previous.connectionState !== undefined) {
    if (
      current.connectionState === "connected" &&
      previous.connectionState !== "connected"
    ) {
      add(
        "SERVER RECONNECTED",
        "Telemetry server connection restored",
        "nominal",
        "server",
      );
    } else if (
      current.connectionState !== "connected" &&
      previous.connectionState === "connected"
    ) {
      add(
        "SERVER DISCONNECTED",
        "Telemetry server connection lost",
        "alarm",
        "server",
      );
    }
  }
  if (previous.linkState && previous.linkState !== current.linkState) {
    if (current.linkState === "BLACKOUT") {
      add("BLACKOUT ON", "Telemetry link blackout", "alarm", "link");
    } else if (previous.linkState === "BLACKOUT") {
      add("BLACKOUT OFF", "Telemetry link restored", "nominal", "link");
    } else if (current.linkState === "AOS") {
      add("AOS", "Link restored", "nominal", "link");
    } else if (current.linkState === "DEGRADED") {
      add("DEGRADED", "Link quality degraded", "warning", "link");
    } else if (current.linkState === "LOS") {
      const seconds = Math.floor((current.lastContactMs ?? 0) / 1000);
      add("LOS", `Last contact ${seconds} s ago`, "alarm", "link");
    }
  }

  const knownHazards = new Set(previous.hazardIds ?? []);
  for (const hazard of current.hazards ?? []) {
    if (knownHazards.has(hazard.id)) continue;
    knownHazards.add(hazard.id);
    add(
      `NEW HAZARD ${String(hazard.class).toUpperCase()}`,
      `${hazard.class} (${(hazard.x_cm / 100).toFixed(2)} m, ${(hazard.y_cm / 100).toFixed(2)} m)`,
      "info",
      "hazard",
    );
  }

  return {
    events,
    state: {
      connectionState: current.connectionState,
      linkState: current.linkState,
      hazardIds: [...knownHazards],
      tMs: current.tMs,
      nextId,
    },
  };
}

export function filterEvents(events, filter) {
  if (filter === "all") return events;
  if (filter === "exclude-sim") {
    return events.filter((item) => !item.simulated && !item.code.startsWith("SIM"));
  }
  return events.filter((item) => item.type === filter);
}

export function checklistProgress(steps, checked) {
  return steps.length
    ? Math.round((checked.filter(Boolean).length / steps.length) * 100)
    : 0;
}
