import { useTelemetry } from "./hooks/useTelemetry.js";
import LinkStatus from "./components/LinkStatus.jsx";
import Legend from "./components/Legend.jsx";
import MapCanvas from "./components/MapCanvas.jsx";
import AccessibilityPanel from "./components/AccessibilityPanel.jsx";
import LeftSidebar from "./components/LeftSidebar.jsx";
import WallDisplay from "./components/WallDisplay.jsx";
import {
  ageStage,
  contactState,
  DETECTION_CLASSES,
  formatAge,
  getAge,
  lastPacketTone,
  parseTelemetryMetricsFile,
  TELEMETRY_CONFIG,
  uncertaintyComponents,
} from "./lib/telemetry.js";
import {
  calculateBytesPerSecond,
  generateStateEvents,
} from "./lib/sidebar.js";
import {
  addContactAgeOffset,
  addDisplayAgeOffset,
  clearLinkPreview,
  createScenarioRoverPath,
  createScenarioSnapshot,
  SIMULATION_DURATION_MS,
  scenarioEvents,
  shouldDisplayPreviewSnapshot,
  toDisplayHazards,
} from "./lib/simulation.js";
import { DASHBOARD_CONFIG } from "./config.js";

const { useEffect, useRef, useState } = React;
const h = React.createElement;
const REPLAY_WINDOW_MS = TELEMETRY_CONFIG.replayWindowMs;
const REMOVE_AFTER_MS = TELEMETRY_CONFIG.ageMs.remove;
const HIDE_EXPIRED_AFTER_MS = TELEMETRY_CONFIG.ageMs.expired;
const ACCESSIBILITY_STORAGE_KEY = "crater-accessibility-settings";
const MOCK_SIMULATION_MODE =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get(
    DASHBOARD_CONFIG.wallDisplay.simulationQueryParam,
  ) === "1";
const UI_ZOOM_STEPS = [80, 90, 100, 115, 130, 150, 175];

function readAccessibilitySettings() {
  const defaults = {
    theme: "dark",
    uiZoom: 100,
    voiceEnabled: false,
    volume: 0.8,
    rate: 1,
  };
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(ACCESSIBILITY_STORAGE_KEY) ?? "null",
    );
    if (!stored || typeof stored !== "object") return defaults;
    return {
      theme: stored.theme === "light" ? "light" : "dark",
      uiZoom: UI_ZOOM_STEPS.includes(stored.uiZoom) ? stored.uiZoom : 100,
      voiceEnabled: stored.voiceEnabled === true,
      volume:
        Number.isFinite(stored.volume) && stored.volume >= 0 && stored.volume <= 1
          ? stored.volume
          : defaults.volume,
      rate:
        Number.isFinite(stored.rate) && stored.rate >= 0.7 && stored.rate <= 1.3
          ? stored.rate
          : defaults.rate,
    };
  } catch {
    return defaults;
  }
}

function distanceWords(value, positive, negative) {
  return `${Math.abs(value / 100).toFixed(0)} meters ${
    value > 0 ? positive : value < 0 ? negative : "from the landing site"
  }`;
}

function classKey(className) {
  return DETECTION_CLASSES.some((item) => item.value === className)
    ? className
    : "unknown";
}

function classLabel(className) {
  return (
    DETECTION_CLASSES.find((item) => item.value === className)?.label ??
    className
  );
}

function formatMissionTime(timeMs) {
  const totalSeconds = Math.max(0, Math.floor((timeMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `T+${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(seconds).padStart(2, "0")}`;
}

function statusLabel(status) {
  if (status === "BLACKOUT") return "BLACKOUT";
  if (status === "DEGRADED") return "DEGRADED";
  if (status === "AOS") return "AOS";
  return "LOS";
}

function DebugPanel({ diagnostics }) {
  return h(
    "section",
    { className: "panel debug-panel", "aria-label": "Telemetry debug details" },
    h(
      "div",
      { className: "panel-heading" },
      h("h2", null, "Telemetry debug"),
      h("span", null, `WebSocket: ${diagnostics.webSocketState}`),
    ),
    h(
      "div",
      { className: "debug-metrics" },
      h("span", null, `Snapshot rate: ${diagnostics.snapshotRateHz.toFixed(2)} Hz`),
      h("span", null, `Average snapshot: ${diagnostics.averageSnapshotBytes.toFixed(0)} bytes`),
      h("span", null, `Contract issues: ${diagnostics.contractIssueCount}`),
    ),
    h("h3", null, "Last raw message"),
    h("pre", { className: "debug-raw" }, diagnostics.rawMessage || "(none)"),
    h(
      "h3",
      null,
      `Violations (${diagnostics.violations.length} most recent)`,
    ),
    diagnostics.violations.length
      ? h(
          "ol",
          { className: "debug-violations" },
          ...diagnostics.violations.map((violation, index) =>
            h(
              "li",
              { key: `${violation.time}:${index}` },
              `${new Date(violation.time).toLocaleTimeString()} ${violation.message}`,
            ),
          ),
        )
      : h("p", null, "No contract violations."),
  );
}

function HazardList({
  hazards,
  viewTimeMs,
  selectedHazardId,
  onSelect,
  simulationActive,
  roverPosition,
}) {
  return h(
    "section",
    { className: "panel hazard-panel", "aria-label": "Latest hazards" },
    h(
      "div",
      { className: "panel-heading" },
      h("h2", null, "LATEST HAZARDS"),
      h("span", { className: "count-badge" }, `${hazards.length} targets`),
    ),
    hazards.length
      ? h(
          "div",
          { className: "hazard-table-wrap" },
          h(
            "table",
            { className: "hazard-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                ...["CLASS", "X", "Y", "CONF", "±SIGMA", "AGE"].map((label) =>
                  h("th", { key: label, scope: "col" }, label),
                ),
              ),
            ),
            h(
              "tbody",
              null,
              ...hazards.map((hazard) => {
                const age = getAge(hazard, hazard.receivedAt, viewTimeMs);
                const stage = ageStage(age).toLowerCase();
                const key = classKey(hazard.class);
                const uncertainty = uncertaintyComponents(
                  hazard,
                  age,
                  roverPosition,
                );
                return h(
                  "tr",
                  { key: hazard.id },
                  h(
                    "td",
                    null,
                    h(
                      "button",
                      {
                        type: "button",
                        className: `hazard-row-button age-${stage}${
                          selectedHazardId === hazard.id ? " selected" : ""
                        }`,
                        onClick: () => onSelect(hazard.id),
                        "aria-pressed": selectedHazardId === hazard.id,
                        title: "Highlight this detection on the map",
                      },
                      h("span", {
                        className: `class-swatch class-${key}`,
                        "aria-hidden": "true",
                      }),
                      classLabel(hazard.class),
                      simulationActive
                        ? h("em", { className: "simulation-tag" }, "SIM")
                        : null,
                    ),
                  ),
                  h(
                    "td",
                    { className: `age-${stage}` },
                    `${(hazard.x_cm / 100).toFixed(2)} m`,
                  ),
                  h(
                    "td",
                    { className: `age-${stage}` },
                    `${(hazard.y_cm / 100).toFixed(2)} m`,
                  ),
                  h(
                    "td",
                    { className: `age-${stage}` },
                    `${hazard.conf}/7 · ${Math.round((hazard.conf / 7) * 100)}%`,
                  ),
                  h(
                    "td",
                    { className: `age-${stage}` },
                    `${uncertainty.estimated ? "est. " : ""}±${(uncertainty.geometryCm / 100).toFixed(2)} m${uncertainty.estimated && !uncertainty.distanceAvailable ? " · range n/a" : ""}`,
                  ),
                  h(
                    "td",
                    { className: `age-${stage}` },
                    `seen ${formatAge(age)}`,
                  ),
                );
              }),
            ),
          ),
        )
      : h(
          "p",
          { className: "empty-state hazard-empty" },
          "NO HAZARD CONTACT",
        ),
  );
}

function DetectionDetails({ hazard, viewTimeMs, roverPosition }) {
  if (!hazard) {
    return h(
      "section",
      { className: "panel detection-panel" },
      h(
        "div",
        { className: "panel-heading" },
        h(
          "div",
          null,
          h("h2", null, "SELECTED HAZARD"),
        ),
      ),
      h(
        "p",
        { className: "empty-state detection-empty" },
        "SELECT A HAZARD TO VIEW DETAILS",
      ),
    );
  }

  const age = getAge(hazard, hazard.receivedAt, viewTimeMs);
  const stage = ageStage(age).toLowerCase();
  const key = classKey(hazard.class);
  const uncertainty = uncertaintyComponents(hazard, age, roverPosition);
  return h(
    "section",
    { className: `panel detection-panel age-${stage}` },
    h(
      "div",
      { className: "panel-heading" },
      h(
        "div",
        null,
        h("h2", null, "SELECTED HAZARD"),
      ),
      h("span", { className: "count-badge" }, hazard.id),
    ),
    h(
      "div",
      { className: "latest-detection" },
      h("span", { className: `class-swatch class-${key}` }),
      h(
        "div",
        { className: "detection-details" },
        h("strong", null, classLabel(hazard.class)),
        h(
          "span",
          null,
          `X ${(hazard.x_cm / 100).toFixed(2)} m · Y ${(hazard.y_cm / 100).toFixed(2)} m`,
        ),
        h(
          "span",
          null,
          `Confidence ${hazard.conf}/7 (${Math.round((hazard.conf / 7) * 100)}%) · ${stage.toUpperCase()}`,
        ),
        h(
          "span",
          null,
          `±sigma ${(uncertainty.geometryCm / 100).toFixed(2)} m${uncertainty.estimated ? ` estimated${uncertainty.distanceAvailable ? "" : " · rover range unavailable"}` : ""} · uncertainty radius ${(uncertainty.radiusCm / 100).toFixed(2)} m`,
        ),
      ),
      h(
        "span",
        { className: "confidence" },
        `Seen ${formatAge(age)}`,
        h("small", null, "detection age"),
      ),
    ),
  );
}

export default function App() {
  const {
    snapshotRef,
    hazardsRef,
    roverPathRef,
    link,
    linkHistory,
    lastSnapshotAgeMs,
    clockNow,
    connectionState,
    sendBlackout,
    rawMessage,
    snapshotRateHz,
    averageSnapshotBytes,
    contractIssueCount,
    violations,
    webSocketState,
  } = useTelemetry();
  const [selectedHazardId, setSelectedHazardId] = useState(null);
  const [wallDisplayActive, setWallDisplayActive] = useState(false);
  const wallModeButtonRef = useRef(null);
  const previousWallModeRef = useRef(false);
  const mapViewRef = useRef({
    zoom: 1,
    panX: 0,
    panY: 0,
    followRover: false,
  });
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches,
  );
  const [paused, setPaused] = useState(false);
  const [replayTimeMs, setReplayTimeMs] = useState(null);
  const [replayWindowEndMs, setReplayWindowEndMs] = useState(null);
  const [followRover, setFollowRover] = useState(false);
  const [classFilters, setClassFilters] = useState({
    crater: true,
    rock: true,
    ice: true,
    slope: true,
    unknown: true,
  });
  const [hideExpired, setHideExpired] = useState(true);
  const [showUncertainty, setShowUncertainty] = useState(true);
  const [showRoverPath, setShowRoverPath] = useState(true);
  const [showAxisChecks, setShowAxisChecks] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [accessibility, setAccessibility] = useState(readAccessibilitySettings);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [events, setEvents] = useState([]);
  const [bytesPerSecond, setBytesPerSecond] = useState(null);
  const [fileMetrics, setFileMetrics] = useState(null);
  const [simulation, setSimulation] = useState({
    active: false,
    playing: false,
    elapsedMs: 0,
    speed: 1,
  });
  const [warpSeconds, setWarpSeconds] = useState(0);
  const [linkScenario, setLinkScenario] = useState("live");
  const [blackoutRun, setBlackoutRun] = useState(null);
  const [simulationMessage, setSimulationMessage] = useState("");
  const previewDataRef = useRef({
    hazards: [],
    roverPath: [],
    snapshot: null,
    sequence: 0,
    lastReceivedAt: null,
  });
  const mapHazardsRef = useRef([]);
  const mapRoverPathRef = useRef([]);
  const disconnectedSinceRef = useRef(null);
  const promptedForDisconnectRef = useRef(false);
  const previousBandwidthSampleRef = useRef(null);
  const sendBlackoutRef = useRef(sendBlackout);
  sendBlackoutRef.current = sendBlackout;
  const blackoutReleaseSentRef = useRef(false);
  const speechRef = useRef({
    available: false,
    enabled: false,
    queue: [],
    timer: null,
    lastSpokenAt: 0,
    voices: [],
  });
  const speechPumpRef = useRef(null);
  const snapshot = snapshotRef.current;
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1100px)");
    const updateDefault = (event) => setLeftSidebarOpen(event.matches);
    query.addEventListener?.("change", updateDefault);
    return () => query.removeEventListener?.("change", updateDefault);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key.toLowerCase() !== "b" || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      setLeftSidebarOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (previousWallModeRef.current && !wallDisplayActive) {
      wallModeButtonRef.current?.focus();
    }
    previousWallModeRef.current = wallDisplayActive;
  }, [wallDisplayActive]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (
        event.key.toLowerCase() !== "w" ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      setWallDisplayActive((active) => !active);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const metricsUrl = "/tests/output/telemetry_metrics.json";
    fetch(metricsUrl)
      .then((response) => {
        if (response.status === 404) return null;
        if (!response.ok) {
          throw new Error(`Metrics request failed: ${response.status}`);
        }
        return response.text();
      })
      .then((text) => {
        if (text === null) return;
        const parsed = parseTelemetryMetricsFile(text);
        if (parsed) setFileMetrics(parsed);
        else console.error("Ignoring invalid telemetry metrics file.");
      })
      .catch((error) => {
        console.error("Unable to load optional telemetry metrics:", error);
      });
  }, []);

  useEffect(() => {
    if (!snapshot || !Number.isFinite(snapshot.receivedAt)) return;
    const previous = previousBandwidthSampleRef.current;
    if (previous) {
      setBytesPerSecond(
        calculateBytesPerSecond(
          snapshot.link?.bytes_rx,
          previous.bytes,
          snapshot.receivedAt - previous.receivedAt,
        ),
      );
    }
    previousBandwidthSampleRef.current = {
      bytes: snapshot.link?.bytes_rx,
      receivedAt: snapshot.receivedAt,
    };
  }, [snapshot?.receivedAt]);

  useEffect(() => {
    if (linkScenario === "noisy") {
      previewDataRef.current = {
        hazards: hazardsRef.current.slice(),
        roverPath: roverPathRef.current.slice(),
        snapshot,
        sequence: 0,
        lastReceivedAt: snapshot?.receivedAt ?? null,
      };
      return;
    }
    previewDataRef.current = {
      hazards: [],
      roverPath: [],
      snapshot: null,
      sequence: 0,
      lastReceivedAt: null,
    };
  }, [linkScenario]);

  useEffect(() => {
    if (
      linkScenario !== "noisy" ||
      !snapshot ||
      !Number.isFinite(snapshot.receivedAt) ||
      previewDataRef.current.lastReceivedAt === snapshot.receivedAt
    ) {
      return;
    }
    const preview = previewDataRef.current;
    preview.lastReceivedAt = snapshot.receivedAt;
    preview.sequence += 1;
    if (!shouldDisplayPreviewSnapshot(preview.sequence, 30)) return;

    const receivedAt = snapshot.receivedAt;
    const nextHazards = new Map(
      preview.hazards.map((hazard) => [hazard.id, hazard]),
    );
    for (const hazard of snapshot.hazards) {
      nextHazards.set(hazard.id, {
        ...hazard,
        receivedAt,
        eventTimeMs: receivedAt - (hazard.age_ms ?? 0),
      });
    }
    preview.hazards = [...nextHazards.values()].filter(
      (hazard) => getAge(hazard, hazard.receivedAt, receivedAt) <= REMOVE_AFTER_MS,
    );
    for (const sample of snapshot.roverSamples ?? []) {
      const identity = `${sample.id}:${sample.ts_ms ?? sample.first_rx_ms ?? `${sample.x_cm}:${sample.y_cm}`}`;
      if (preview.roverPath.some((point) => point.identity === identity)) continue;
      preview.roverPath.push({
        ...sample,
        receivedAt,
        eventTimeMs: receivedAt - (sample.age_ms ?? 0),
        identity,
      });
    }
    preview.snapshot = snapshot;
  }, [linkScenario, snapshot?.receivedAt]);

  useEffect(() => {
    if (!simulation.active || !simulation.playing) return undefined;
    let previousTick = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = (now - previousTick) * simulation.speed;
      previousTick = now;
      setSimulation((current) => {
        const elapsedMs = Math.min(SIMULATION_DURATION_MS, current.elapsedMs + elapsed);
        return {
          ...current,
          elapsedMs,
          playing: elapsedMs < 180_000,
        };
      });
    }, 200);
    return () => window.clearInterval(timer);
  }, [simulation.active, simulation.playing, simulation.speed]);

  useEffect(() => {
    if (!blackoutRun) return undefined;
    const timer = window.setInterval(() => {
      const remainingMs = blackoutRun.endAt - Date.now();
      if (remainingMs <= 0 && !blackoutReleaseSentRef.current) {
        blackoutReleaseSentRef.current = true;
        if (sendBlackoutRef.current(false)) {
          setSimulationMessage("Restore request sent; waiting for link.blackout: false.");
        } else {
          setSimulationMessage("Unable to send restore request: WebSocket is closed.");
        }
        setBlackoutRun(null);
      } else {
        setBlackoutRun((current) =>
          current ? { ...current, remainingSeconds: Math.ceil(remainingMs / 1000) } : null,
        );
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [blackoutRun?.endAt]);

  useEffect(() => {
    if (connectionState === "connected") {
      disconnectedSinceRef.current = null;
      promptedForDisconnectRef.current = false;
      return undefined;
    }
    if (disconnectedSinceRef.current === null) {
      disconnectedSinceRef.current = Date.now();
    }
    const timer = window.setInterval(() => {
      if (
        simulation.active ||
        promptedForDisconnectRef.current ||
        Date.now() - disconnectedSinceRef.current < 10_000
      ) {
        return;
      }
      promptedForDisconnectRef.current = true;
      if (window.confirm("The telemetry server has been disconnected for over 10 seconds. Start the offline scenario player?")) {
        startScenario(true);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [connectionState, simulation.active]);

  const startScenario = (restart = false) => {
    setSimulation((current) => ({
      active: true,
      playing: true,
      elapsedMs:
        restart || !current.active || current.elapsedMs >= SIMULATION_DURATION_MS
          ? 0
          : current.elapsedMs,
      speed: current.speed,
    }));
    setSelectedHazardId(null);
    setPaused(false);
    setReplayTimeMs(null);
    setReplayWindowEndMs(null);
    setSimulationMessage("");
  };

  const requestScenarioBlackout = () => {
    if (simulation.active) {
      setSimulationMessage("Stop the scenario player before requesting a live blackout.");
      return;
    }
    if (!sendBlackout(true)) {
      setSimulationMessage("Unable to send blackout request: WebSocket is closed.");
      return;
    }
    setLinkScenario("live");
    blackoutReleaseSentRef.current = false;
    setBlackoutRun({
      endAt: Date.now() + 60_000,
      remainingSeconds: 60,
    });
    setSimulationMessage("Blackout request sent; waiting for link.blackout: true.");
  };

  const patchAccessibility = (patch) =>
    setAccessibility((current) => ({ ...current, ...patch }));
  const darkMode = accessibility.theme === "dark";

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = accessibility.theme;
    root.dataset.uiZoom = String(accessibility.uiZoom);
    root.style.fontSize = `${accessibility.uiZoom}%`;
  }, [accessibility]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ACCESSIBILITY_STORAGE_KEY,
        JSON.stringify(accessibility),
      );
    } catch {
      // Settings remain active for this page even when storage is unavailable.
    }
  }, [accessibility]);

  useEffect(() => {
    const synthesis = window.speechSynthesis;
    if (
      !synthesis ||
      typeof synthesis.getVoices !== "function" ||
      typeof window.SpeechSynthesisUtterance !== "function"
    ) {
      setVoiceAvailable(false);
      return undefined;
    }
    const refreshVoices = () => {
      const voices = synthesis.getVoices().filter((voice) => voice.localService);
      speechRef.current.voices = voices;
      speechRef.current.available = voices.length > 0;
      setVoiceAvailable(voices.length > 0);
    };
    refreshVoices();
    synthesis.addEventListener?.("voiceschanged", refreshVoices);
    return () =>
      synthesis.removeEventListener?.("voiceschanged", refreshVoices);
  }, []);

  speechPumpRef.current = () => {
    const state = speechRef.current;
    if (
      !state.available ||
      !state.enabled ||
      state.queue.length === 0 ||
      window.speechSynthesis.speaking ||
      state.timer !== null
    ) {
      return;
    }
    const delay = Math.max(0, state.lastSpokenAt + 3000 - Date.now());
    if (delay > 0) {
      state.timer = window.setTimeout(() => {
        state.timer = null;
        speechPumpRef.current?.();
      }, delay);
      return;
    }

    const message = state.queue.shift();
    const utterance = new window.SpeechSynthesisUtterance(message);
    utterance.volume = accessibility.volume;
    utterance.rate = accessibility.rate;
    const language = navigator.language?.toLowerCase();
    utterance.voice =
      state.voices.find((voice) =>
        voice.lang.toLowerCase().startsWith(language ?? ""),
      ) ?? state.voices[0];
    state.lastSpokenAt = Date.now();
    setLiveMessage(message);
    utterance.onend = () => speechPumpRef.current?.();
    utterance.onerror = () => speechPumpRef.current?.();
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      state.available = false;
      setVoiceAvailable(false);
    }
  };

  useEffect(() => {
    const state = speechRef.current;
    state.enabled = accessibility.voiceEnabled && voiceAvailable;
    state.available = voiceAvailable;
    if (state.enabled) {
      speechPumpRef.current?.();
      return undefined;
    }
    state.queue = [];
    window.clearTimeout(state.timer);
    state.timer = null;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    return undefined;
  }, [accessibility.voiceEnabled, accessibility.volume, accessibility.rate, voiceAvailable]);

  const enqueueSpeech = (message) => {
    const state = speechRef.current;
    if (!state.enabled || !state.available) return;
    state.queue.push(message);
    if (state.queue.length > 3) state.queue.shift();
    speechPumpRef.current?.();
  };

  const eventStateRef = useRef({ connectionState: null, hazardIds: [] });
  const serverConnected = connectionState === "connected";
  const signalLost =
    serverConnected &&
    (link?.since_last_rx_ms ?? lastSnapshotAgeMs ?? 0) > 10_000;
  const missionTimeMs = snapshotRef.current?.t_ms ?? 0;
  const rawLinkState = contactState({
    serverConnected,
    lastSnapshotAgeMs,
    link,
  });
  const linkState =
    rawLinkState === "BLACKOUT"
      ? "BLACKOUT"
      : rawLinkState === "DEGRADED" && !signalLost
        ? "DEGRADED"
        : rawLinkState === "LINKED" && !signalLost
          ? "AOS"
          : "LOS";
  const currentEventState = {
    connectionState,
    linkState,
    hazards: hazardsRef.current,
    tMs: missionTimeMs,
    lastContactMs: link?.since_last_rx_ms,
  };
  useEffect(() => {
    const result = generateStateEvents(eventStateRef.current, currentEventState);
    eventStateRef.current = result.state;
    if (!result.events.length) return;
    setEvents((current) => [...result.events.slice().reverse(), ...current].slice(0, 100));
    for (const item of result.events) {
      if (item.code === "SERVER RECONNECTED") enqueueSpeech("Server reconnected.");
      else if (item.code === "SERVER DISCONNECTED") enqueueSpeech("Server disconnected.");
      else if (item.code === "BLACKOUT ON") enqueueSpeech("Blackout on.");
      else if (item.code === "BLACKOUT OFF") enqueueSpeech("Blackout off.");
      else if (item.code === "AOS") enqueueSpeech("Signal acquired.");
      else if (item.code === "DEGRADED") enqueueSpeech("Signal degraded.");
      else if (item.code === "LOS") {
        const seconds = Math.floor((link?.since_last_rx_ms ?? 0) / 1000);
        enqueueSpeech(`Signal lost. Last contact ${seconds} seconds ago.`);
      } else if (
        item.type === "hazard" &&
        (item.code.includes("ICE") || item.code.includes("CRATER"))
      ) {
        const hazard = hazardsRef.current.find((candidate) =>
          item.message ===
          `${candidate.class} (${(candidate.x_cm / 100).toFixed(2)} m, ${(candidate.y_cm / 100).toFixed(2)} m)`,
        );
        if (hazard) {
          enqueueSpeech(
            `New ${hazard.class} detection, ${distanceWords(
              hazard.x_cm,
              "east",
              "west",
            )}, ${distanceWords(hazard.y_cm, "north", "south")}.`,
          );
        }
      }
    }
  }, [
    connectionState,
    hazardsRef.current.length,
    link?.since_last_rx_ms,
    linkState,
    missionTimeMs,
    accessibility.voiceEnabled,
    voiceAvailable,
  ]);
  const simulationSnapshot = simulation.active
    ? createScenarioSnapshot(simulation.elapsedMs)
    : null;
  const simulationHazards = simulationSnapshot
    ? addDisplayAgeOffset(toDisplayHazards(simulationSnapshot, clockNow), warpSeconds * 1000)
    : null;
  const previewSnapshot =
    linkScenario === "noisy" ? previewDataRef.current.snapshot : null;
  const displaySnapshot = simulationSnapshot ?? previewSnapshot ?? snapshot;
  const displayBaseLink = simulationSnapshot?.link
    ?? (linkScenario === "noisy" ? previewSnapshot?.link : null)
    ?? link;
  const previewLink =
    !simulation.active && linkScenario === "clear"
      ? clearLinkPreview(displayBaseLink)
      : displayBaseLink;
  const displaySnapshotAge = simulationSnapshot
    ? 0
    : linkScenario === "noisy" && previewSnapshot
      ? Math.max(0, clockNow - previewSnapshot.receivedAt)
      : lastSnapshotAgeMs;
  const displayLinkWithElapsed =
    displaySnapshot && !simulationSnapshot && linkScenario === "noisy"
      ? {
          ...displayBaseLink,
          since_last_rx_ms:
            (displayBaseLink?.since_last_rx_ms ?? 0) + displaySnapshotAge,
        }
      : displayBaseLink;
  const contactAges = addContactAgeOffset(
    linkScenario === "clear" && !simulation.active
      ? previewLink
      : displayLinkWithElapsed,
    displaySnapshotAge,
    warpSeconds * 1000,
  );
  const displayLink = contactAges.link;
  const displayLastSnapshotAgeMs = contactAges.snapshotAgeMs;
  const displayServerConnected = simulation.active || serverConnected;
  const displayRawLinkState = contactState({
    serverConnected: displayServerConnected,
    lastSnapshotAgeMs: displayLastSnapshotAgeMs,
    link: displayLink,
  });
  const displayLinkState =
    displayRawLinkState === "BLACKOUT"
      ? "BLACKOUT"
      : displayRawLinkState === "DEGRADED"
        ? "DEGRADED"
        : displayRawLinkState === "LINKED"
          ? "AOS"
          : "LOS";
  const displaySignalLost =
    displayServerConnected &&
    (displayLink?.since_last_rx_ms ?? displayLastSnapshotAgeMs ?? 0) > 10_000;
  const simulationRoverPath = simulationSnapshot
    ? createScenarioRoverPath(simulationSnapshot.t_ms, clockNow)
    : null;
  mapHazardsRef.current = simulation.active
    ? simulationHazards
    : linkScenario === "noisy"
      ? addDisplayAgeOffset(previewDataRef.current.hazards, warpSeconds * 1000)
      : addDisplayAgeOffset(hazardsRef.current, warpSeconds * 1000);
  mapRoverPathRef.current = simulation.active
    ? simulationRoverPath
    : linkScenario === "noisy"
      ? previewDataRef.current.roverPath
      : roverPathRef.current;
  const viewTimeMs = paused && replayTimeMs !== null ? replayTimeMs : clockNow;
  const sliderMaxMs =
    paused && replayWindowEndMs !== null ? replayWindowEndMs : clockNow;
  const sliderMinMs = sliderMaxMs - REPLAY_WINDOW_MS;
  const replayStart = viewTimeMs - REPLAY_WINDOW_MS;
  const displayRoverPosition =
    mapRoverPathRef.current
      .filter(
        (point) =>
          point.eventTimeMs >= replayStart && point.eventTimeMs <= viewTimeMs,
      )
      .slice(-1)[0] ?? null;
  const visibleHazards = mapHazardsRef.current
    .filter((hazard) => {
      const age = getAge(hazard, hazard.receivedAt, viewTimeMs);
      return (
        hazard.eventTimeMs >= replayStart &&
        hazard.eventTimeMs <= viewTimeMs &&
        classFilters[classKey(hazard.class)] &&
        age <= REMOVE_AFTER_MS &&
        (!hideExpired || age <= HIDE_EXPIRED_AFTER_MS)
      );
    })
    .sort((a, b) => b.eventTimeMs - a.eventTimeMs);
  const latestHazards = visibleHazards.slice(0, 10);
  const selectedHazard = mapHazardsRef.current.find(
    (hazard) => hazard.id === selectedHazardId,
  );
  const selectedAtView =
    selectedHazard &&
    selectedHazard.eventTimeMs >= replayStart &&
    selectedHazard.eventTimeMs <= viewTimeMs;
  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setReplayTimeMs(null);
      setReplayWindowEndMs(null);
    } else {
      setReplayTimeMs(clockNow);
      setReplayWindowEndMs(clockNow);
      setPaused(true);
    }
  };
  const setReplayTime = (time) => {
    if (!paused) setReplayWindowEndMs(clockNow);
    setReplayTimeMs(time);
    setPaused(true);
  };
  const readStatusNow = () => {
    const hazards = hazardsRef.current.filter((hazard) => hazard.class !== "beacon");
    const counts = new Map(DETECTION_CLASSES.map(({ value }) => [value, 0]));
    for (const hazard of hazards) {
      const className = classKey(hazard.class);
      counts.set(className, (counts.get(className) ?? 0) + 1);
    }
    const countsText = DETECTION_CLASSES.map(
      ({ value, label }) => `${counts.get(value) ?? 0} ${label}`,
    ).join(", ");
    const newestAge = hazards.length
      ? formatAge(
          Math.min(
            ...hazards.map((hazard) => getAge(hazard, hazard.receivedAt, clockNow)),
          ),
        )
      : "no detections";
    const stateText =
      linkState === "AOS"
        ? "signal acquired"
        : linkState === "LOS"
          ? `signal lost, last contact ${Math.floor((link?.since_last_rx_ms ?? 0) / 1000)} seconds ago`
          : linkState.toLowerCase();
    enqueueSpeech(
      `${stateText}. Packet loss ${(link?.loss_pct ?? 0).toFixed(1)} percent. Hazards: ${countsText}. Most recent detection age: ${newestAge}.`,
    );
  };
  const displayMissionTimeMs = displaySnapshot?.t_ms;
  const wallSimulationActive =
    simulation.active ||
    MOCK_SIMULATION_MODE ||
    warpSeconds !== 0 ||
    linkScenario !== "live";
  const displayEvents = simulation.active
    ? scenarioEvents(simulation.elapsedMs)
    : wallSimulationActive
      ? events.map((item) => ({ ...item, simulated: true }))
      : events;
  const simulationBanner = simulation.active
    ? { text: "SIMULATION - not rover data", simulated: true, preview: false }
    : MOCK_SIMULATION_MODE || warpSeconds !== 0
      ? { text: "SIMULATION - not rover data", simulated: true, preview: false }
    : linkScenario === "noisy"
      ? { text: "NOISY LINK · 30% LOSS · PREVIEW ONLY", simulated: false, preview: true }
      : linkScenario === "clear"
        ? { text: "CLEAR LINK · PREVIEW ONLY", simulated: false, preview: true }
        : null;
  const displayLastPacketAgeMs =
    displayLink?.since_last_rx_ms ?? displayLastSnapshotAgeMs;
  const lastPacketLabel = Number.isFinite(displayLastPacketAgeMs)
    ? formatAge(displayLastPacketAgeMs)
    : "—";

  return h(
    "main",
    {
      className: `mission-control ${darkMode ? "dark-mode" : "light-mode"}${wallDisplayActive ? " wall-mode-active" : ""}`,
    },
    h(
      "div",
      {
        className: "operator-view",
        "aria-hidden": wallDisplayActive ? "true" : undefined,
      },
    h(
      "header",
      { className: "topbar" },
      h(
        "div",
        { className: "brand" },
        h("div", { className: "brand-mark", "aria-hidden": "true" }, "C"),
        h(
          "div",
          null,
          h("p", { className: "eyebrow" }, "Lunar surface operations"),
          h("h1", null, "C.R.A.T.E.R."),
        ),
      ),
      h(
        "div",
        { className: "mission-clock" },
        h("span", { className: "eyebrow" }, "MISSION CLOCK"),
        h("strong", null, formatMissionTime(displayMissionTimeMs)),
      ),
      h(
        "div",
        {
          className: `last-packet last-packet-${lastPacketTone(displayLastPacketAgeMs)}`,
          "aria-label": `Last packet: ${lastPacketLabel}`,
        },
        h("span", { className: "eyebrow" }, "LAST PACKET"),
        h("strong", null, Number.isFinite(displayLastPacketAgeMs) ? ` ${lastPacketLabel}` : "—"),
      ),
      h(
        "div",
        { className: `top-status status-${displayLinkState.toLowerCase()}` },
        h("span", { className: "status-dot" }),
        h("strong", null, statusLabel(displayLinkState)),
        displayLinkState === "LOS"
          ? h(
              "span",
              null,
              Number.isFinite(displayLink?.since_last_rx_ms)
                ? `last contact ${Math.floor(displayLink.since_last_rx_ms / 1000)} s ago`
                : "last contact —",
            )
          : null,
      ),
      h(
        "div",
        { className: `server-badge ${serverConnected ? "connected" : "disconnected"}` },
        h("span", { className: "server-dot" }),
        serverConnected ? "SERVER CONNECTED" : "SERVER DISCONNECTED",
      ),
      h(
        "button",
        {
          type: "button",
          className: "wall-mode-toggle",
          ref: wallModeButtonRef,
          "aria-pressed": wallDisplayActive,
          onClick: () => setWallDisplayActive(true),
        },
        "Wall display",
        h("kbd", null, "W"),
      ),
    ),
    simulationBanner
      ? h(
          "div",
          { className: "simulation-banner", role: "status" },
          simulationBanner.text,
          wallSimulationActive
            ? h("span", { className: "simulation-tag" }, "SIM")
            : null,
        )
      : null,
    h(
      "section",
      {
        className: `dashboard-grid${leftSidebarOpen ? " sidebar-open" : ""}`,
        "aria-label": "Mission dashboard",
      },
      h(LeftSidebar, {
        hazard: selectedAtView ? selectedHazard : null,
        viewTimeMs,
        roverPosition: displayRoverPosition,
        events: displayEvents,
        link: displayLink,
        bytesPerSecond,
        snapshot: displaySnapshot,
        fileMetrics,
        hazardCount: mapHazardsRef.current.length,
        simulation: {
          active: simulation.active,
          playing: simulation.playing,
          speed: simulation.speed,
          elapsedMs: simulation.elapsedMs,
          warpSeconds,
          scenario: linkScenario,
          serverConnected,
          blackoutRemainingSeconds: blackoutRun?.remainingSeconds,
          blackoutConfirmed: link?.blackout === true,
          blackoutInProgress: blackoutRun !== null,
          message: simulationMessage,
        },
        simulationActions: {
          onStart: () => startScenario(),
          onPause: () => setSimulation((current) => ({
            ...current,
            elapsedMs: !current.playing && current.elapsedMs >= SIMULATION_DURATION_MS
              ? 0
              : current.elapsedMs,
            playing: !current.playing,
          })),
          onRestart: () => startScenario(true),
          onStop: () => {
            setSimulation({ active: false, playing: false, elapsedMs: 0, speed: 1 });
            setSelectedHazardId(null);
            setPaused(false);
            setReplayTimeMs(null);
            setReplayWindowEndMs(null);
          },
          onSpeedChange: (speed) => setSimulation((current) => ({ ...current, speed })),
          onWarpChange: setWarpSeconds,
          onResetWarp: () => setWarpSeconds(0),
          onScenarioChange: (scenario) => {
            setLinkScenario(scenario);
            setSimulationMessage("");
          },
          onLongBlackout: requestScenarioBlackout,
        },
        open: leftSidebarOpen,
        onToggle: () => setLeftSidebarOpen((open) => !open),
      }),
      h(
        "section",
        {
          className: `map-panel panel${displaySignalLost ? " map-link-lost" : ""}`,
        },
        h(
          "div",
          { className: "panel-heading map-heading" },
          h(
            "div",
            null,
            h("p", { className: "eyebrow" }, "Surface navigation"),
            h("h2", null, "Hazard map"),
          ),
          h(
            "div",
            { className: "map-coordinate" },
            h("span", { className: "tiny-label" }, "LANDING SITE"),
            h("strong", null, "0.0 / 0.0 m"),
          ),
        ),
        h(MapCanvas, {
          hazardsRef: mapHazardsRef,
          roverPathRef: mapRoverPathRef,
          selectedHazardId,
          onSelectHazard: setSelectedHazardId,
          signalLost: displaySignalLost,
          link: displayLink,
          clockNow,
          viewTimeMs,
          sliderMinMs,
          sliderMaxMs,
          paused,
          onTogglePause: togglePause,
          onSetReplayTime: setReplayTime,
          followRover,
          onToggleFollow: setFollowRover,
          classFilters,
          onToggleClass: (className) =>
            setClassFilters((current) => ({
              ...current,
              [className]: !current[className],
            })),
          hideExpired,
          onToggleHideExpired: () => setHideExpired((value) => !value),
          showUncertainty,
          onToggleUncertainty: () => setShowUncertainty((value) => !value),
          showRoverPath,
          onToggleRoverPath: () => setShowRoverPath((value) => !value),
          showAxisChecks,
          onToggleAxisChecks: () => setShowAxisChecks((value) => !value),
          onToggleDebug: () => setShowDebug((value) => !value),
          darkMode,
          displayBanner: simulationBanner,
          simulationActive: wallSimulationActive,
          mapViewRef,
        }),
        h("div", { className: "map-legend-strip" }, h(Legend)),
        h(
          "div",
          { className: "map-footer" },
          h(
            "span",
            null,
            h("i", { className: "origin-symbol" }),
            " Landing site origin",
          ),
          h("span", null, "N ↑ \u00a0·\u00a0 E →"),
        ),
      ),
      h(
        "aside",
        { className: "side-panel", "aria-label": "Telemetry details" },
        h(LinkStatus, {
          link: displayLink,
          linkHistory: simulation.active || linkScenario !== "live" ? [] : linkHistory,
          lastSnapshotAgeMs: displayLastSnapshotAgeMs,
          serverConnected: displayServerConnected,
          connectionState: simulation.active ? "simulation" : connectionState,
          sendBlackout,
          theme: accessibility.theme,
          blackoutPending: blackoutRun !== null,
        }),
        h(HazardList, {
          hazards: latestHazards,
          viewTimeMs,
          selectedHazardId,
          onSelect: setSelectedHazardId,
          simulationActive: wallSimulationActive,
          roverPosition: displayRoverPosition,
        }),
        h(DetectionDetails, {
          hazard: selectedAtView ? selectedHazard : null,
          viewTimeMs,
          roverPosition: displayRoverPosition,
        }),
      ),
    ),
    showDebug
      ? h(DebugPanel, {
          diagnostics: {
            rawMessage,
            snapshotRateHz,
            averageSnapshotBytes,
            contractIssueCount,
            violations,
            webSocketState,
          },
        })
      : null,
    h(AccessibilityPanel, {
      theme: accessibility.theme,
      uiZoom: accessibility.uiZoom,
      voiceEnabled: accessibility.voiceEnabled,
      voiceAvailable,
      volume: accessibility.volume,
      rate: accessibility.rate,
      liveMessage,
      onThemeChange: (theme) => patchAccessibility({ theme }),
      onZoomChange: (uiZoom) => patchAccessibility({ uiZoom }),
      onVoiceChange: (voiceEnabled) => patchAccessibility({ voiceEnabled }),
      onVolumeChange: (volume) => patchAccessibility({ volume }),
      onRateChange: (rate) => patchAccessibility({ rate }),
      onReadStatus: readStatusNow,
    }),
    h(
      "footer",
      { className: "status-footer" },
      h("span", null, "CRATER MISSION CONTROL"),
      h(
        "div",
        { className: "footer-status" },
        contractIssueCount > 0
          ? h(
              "span",
              { className: "contract-issues", role: "status" },
              `contract issues: ${contractIssueCount}`,
            )
          : null,
        h("span", null, "LOCAL TELEMETRY · NO CLOUD CONNECTION"),
      ),
    ),
    ),
    h(WallDisplay, {
      active: wallDisplayActive,
      onBack: () => setWallDisplayActive(false),
      missionTimeMs: displaySnapshot?.t_ms,
      linkState: displayLinkState === "AOS" || displayLinkState === "DEGRADED"
        ? displayLinkState
        : "LOS",
      lastPacketAgeMs: displayLastPacketAgeMs,
      serverConnected,
      hazards: visibleHazards,
      history: simulation.active || linkScenario !== "live" ? [] : linkHistory,
      link: displayLink,
      now: viewTimeMs,
      roverPosition: displayRoverPosition,
      simulated: wallSimulationActive,
      mapViewRef,
      roverPathRef: mapRoverPathRef,
      selectedHazardId,
      onSelectHazard: setSelectedHazardId,
    }),
  );
}
