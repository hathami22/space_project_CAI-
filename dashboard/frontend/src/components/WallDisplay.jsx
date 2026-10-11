import {
  DASHBOARD_CONFIG,
  DETECTION_CLASSES,
  TELEMETRY_CONFIG,
} from "../config.js";
import {
  formatWallValue,
  formatWallAge,
  formatWallMeters,
  createWallDisplayMetrics,
  nearestWallHazard,
  wallMapPoint,
} from "../lib/wallDisplay.js";
import {
  ageVisuals,
  getAge,
  roverUncertaintyRadiusCm,
  uncertaintyRadiusCm,
} from "../lib/telemetry.js";

const { useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;
const WIDTH = DASHBOARD_CONFIG.wallDisplay.designWidth;
const HEIGHT = DASHBOARD_CONFIG.wallDisplay.designHeight;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 68;
const NOMINAL_PACKET_MS =
  TELEMETRY_CONFIG.contact.lastPacketNominalBeforeMs;
const WARNING_PACKET_MS =
  TELEMETRY_CONFIG.contact.lastPacketWarningBeforeMs;
const { millisecondsPerHour, millisecondsPerMinute } =
  DASHBOARD_CONFIG.wallDisplay;
const MAP_SCALE = TELEMETRY_CONFIG.map.pixelsPerCm;
const MAP_GRID_CM = TELEMETRY_CONFIG.map.gridSpacingCm;
const MAP_REDRAW_INTERVAL_MS = TELEMETRY_CONFIG.map.redrawIntervalMs;
const SCHEMATIC = DASHBOARD_CONFIG.wallDisplay.schematic;
const WALL_MAP = DASHBOARD_CONFIG.wallDisplay.map;

function missionTimeLabel(timeMs) {
  if (!Number.isFinite(timeMs)) return "T+--:--:--";
  const seconds = Math.max(
    0,
    Math.floor(timeMs / DASHBOARD_CONFIG.wallDisplay.millisecondsPerSecond),
  );
  return `T+${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(
    Math.floor((seconds % 3600) / 60),
  ).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function classColor(className) {
  return (
    DETECTION_CLASSES.find((item) => item.value === className)?.color ??
    DETECTION_CLASSES.find((item) => item.value === "unknown").color
  );
}

function RoverSchematic({
  hazards,
  selectedHazardId,
  roverPosition,
  now,
  simulated,
}) {
  const selectedHazard = hazards.find((hazard) => hazard.id === selectedHazardId);
  const detection = selectedHazard ?? hazards[0] ?? null;
  const scale = SCHEMATIC.rangeRadiusPx / SCHEMATIC.viewRangeMeters;
  const center = { x: SCHEMATIC.width / 2, y: SCHEMATIC.centerY };
  const rover = roverPosition ?? { x_cm: 0, y_cm: 0 };
  const detectionPoint = detection
    ? {
        x: center.x + ((detection.x_cm - rover.x_cm) / 100) * scale,
        y: center.y - ((detection.y_cm - rover.y_cm) / 100) * scale,
      }
    : null;
  const countByClass = DETECTION_CLASSES.filter(
    ({ value }) => value !== "unknown",
  ).map((item) => ({
    ...item,
    count: hazards.filter((hazard) => hazard.class === item.value).length,
  }));
  const maximum = Math.max(1, ...countByClass.map((item) => item.count));
  const age = detection
    ? getAge(detection, detection.receivedAt, now)
    : null;
  const cardX = SCHEMATIC.width - SCHEMATIC.callout.xOffset;
  const cardY = SCHEMATIC.callout.y;
  return h(
    "div",
    { className: "hud-schematic-content" },
    h(
      "svg",
      {
        className: "hud-rover-schematic",
        viewBox: `0 0 ${SCHEMATIC.width} 310`,
        role: "img",
        "aria-label": "Rover and camera field of view schematic with range rings",
      },
      h("path", {
        className: "hud-camera-cone",
        d: `M ${center.x - 8} ${center.y - 10} L ${center.x - 150} 35 L ${center.x + 150} 35 Z`,
      }),
      h("text", {
        className: "hud-schematic-caption",
        x: 12,
        y: 20,
      }, "SCHEMATIC ONLY · ORIENTATION NOT TELEMETRY"),
      ...DASHBOARD_CONFIG.wallDisplay.schematic.rangeRingsMeters.map(
        (meters) =>
          h(
            React.Fragment,
            { key: meters },
            h("circle", {
              className: "hud-range-ring",
              cx: center.x,
              cy: center.y,
              r: meters * scale,
            }),
            h(
              "text",
              {
                className: "hud-schematic-label",
                x: center.x + 5,
                y: center.y - meters * scale + 15,
              },
              `${meters} m`,
            ),
          ),
      ),
      h("line", {
        className: "hud-schematic-axis",
        x1: center.x,
        y1: 28,
        x2: center.x,
        y2: 298,
      }),
      h("line", {
        className: "hud-schematic-axis",
        x1: 25,
        y1: center.y,
        x2: SCHEMATIC.width - 25,
        y2: center.y,
      }),
      h("rect", {
        className: "hud-rover-body",
        x: center.x - 24,
        y: center.y - 20,
        width: 48,
        height: 40,
        rx: 7,
      }),
      h("circle", {
        className: "hud-camera-lens",
        cx: center.x,
        cy: center.y - 24,
        r: 6,
      }),
      h("text", {
        className: "hud-schematic-label",
        x: center.x,
        y: center.y + 40,
        textAnchor: "middle",
      }, "ROVER"),
      detectionPoint
        ? h(
            React.Fragment,
            null,
            h("line", {
              className: "hud-detection-leader",
              x1: detectionPoint.x,
              y1: detectionPoint.y,
              x2: cardX + 8,
              y2: cardY + 66,
            }),
            h("circle", {
              className: "hud-schematic-detection",
              cx: detectionPoint.x,
              cy: detectionPoint.y,
              r: 7,
              fill: classColor(detection.class),
            }),
            h("rect", {
              className: "hud-callout-card",
              x: cardX,
              y: cardY,
              width: SCHEMATIC.callout.width,
              height: SCHEMATIC.callout.height,
              rx: 3,
            }),
            h("text", {
              className: "hud-callout-title",
              x: cardX + 10,
              y: cardY + 20,
            }, detection.class.toUpperCase()),
            h("text", {
              className: "hud-schematic-label",
              x: cardX + 10,
              y: cardY + 42,
            }, `CONF ${detection.conf}/7`),
            h("text", {
              className: "hud-schematic-label",
              x: cardX + 10,
              y: cardY + 60,
            }, `E ${(detection.x_cm / 100).toFixed(2)} m · N ${(detection.y_cm / 100).toFixed(2)} m`),
            h("text", {
              className: "hud-schematic-label",
              x: cardX + 10,
              y: cardY + 78,
            }, `SEEN ${formatWallAge(age)}${simulated ? " · SIM" : ""}`),
          )
        : h("text", {
            className: "hud-schematic-no-data",
            x: cardX + 10,
            y: cardY + 30,
          }, "no data"),
    ),
    h(
      "div",
      { className: "hud-class-bars", "aria-label": "Hazards per class" },
      hazards.length
        ? countByClass.map((item) =>
            h(
              "div",
              { className: "hud-class-bar-row", key: item.value },
              h("span", null, item.label),
              h(
                "div",
                { className: "hud-class-bar-track" },
                h("i", {
                  style: {
                    width: `${(item.count / maximum) * 100}%`,
                    backgroundColor: item.color,
                  },
                }),
              ),
              h("strong", null, item.count),
            ),
          )
        : h("span", { className: "hud-schematic-no-data" }, "no data"),
    ),
  );
}

function WallMapCanvas({
  active,
  hazards,
  roverPathRef,
  roverPosition,
  selectedHazardId,
  onSelectHazard,
  mapViewRef,
  now,
  simulated,
  linkState,
  frozenAt,
}) {
  const canvasRef = useRef(null);
  const latest = useRef(null);
  latest.current = {
    hazards,
    roverPathRef,
    roverPosition,
    selectedHazardId,
    onSelectHazard,
    mapViewRef,
    now,
    simulated,
    linkState,
    frozenAt,
  };

  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return undefined;
    let frame = 0;
    let lastDrawAt = 0;
    let hitTargets = [];

    const draw = (frameTime) => {
      frame = window.requestAnimationFrame(draw);
      if (frameTime - lastDrawAt < MAP_REDRAW_INTERVAL_MS) return;
      lastDrawAt = frameTime;
      const data = latest.current;
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const ratio = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(bounds.width * ratio);
      const pixelHeight = Math.round(bounds.height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const width = bounds.width;
      const height = bounds.height;
      const camera = data.mapViewRef?.current ?? {
        zoom: 1,
        panX: 0,
        panY: 0,
      };
      const viewport = {
        width,
        height,
        zoom: camera.zoom,
        panX: camera.panX,
        panY: camera.panY,
      };
      const scale = MAP_SCALE * camera.zoom;
      const offsetX = width / 2 + camera.panX * width;
      const offsetY = height / 2 + camera.panY * height;

      context.clearRect(0, 0, width, height);
      context.fillStyle = WALL_MAP.background;
      context.fillRect(0, 0, width, height);
      context.lineWidth = 1;
      context.strokeStyle = WALL_MAP.grid;
      const gridPx = MAP_GRID_CM * scale;
      if (gridPx > 0) {
        const firstX = ((offsetX % gridPx) + gridPx) % gridPx;
        const firstY = ((offsetY % gridPx) + gridPx) % gridPx;
        for (let x = firstX; x < width; x += gridPx) {
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, height);
          context.stroke();
          const worldXcm = (x - offsetX) / scale;
          const gridIndex = Math.round(worldXcm / MAP_GRID_CM);
          if (
            Math.abs(worldXcm - gridIndex * MAP_GRID_CM) < 1 &&
            Math.abs((gridIndex * MAP_GRID_CM) % WALL_MAP.gridLabelIntervalCm) < 1
          ) {
            context.fillStyle = "#8bbbd7";
            context.font = "11px ui-monospace, Consolas, monospace";
            context.fillText(`${Math.round(worldXcm / 100)} m`, x + 3, 56);
          }
        }
        for (let y = firstY; y < height; y += gridPx) {
          context.beginPath();
          context.moveTo(0, y);
          context.lineTo(width, y);
          context.stroke();
          const worldYcm = (offsetY - y) / scale;
          const gridIndex = Math.round(worldYcm / MAP_GRID_CM);
          if (
            Math.abs(worldYcm - gridIndex * MAP_GRID_CM) < 1 &&
            Math.abs((gridIndex * MAP_GRID_CM) % WALL_MAP.gridLabelIntervalCm) < 1
          ) {
            context.fillStyle = "#8bbbd7";
            context.font = "11px ui-monospace, Consolas, monospace";
            context.fillText(`${Math.round(worldYcm / 100)} m`, 6, y - 4);
          }
        }
      }
      const landing = wallMapPoint(
        { x_cm: 0, y_cm: 0 },
        viewport,
        MAP_SCALE,
      );
      context.save();
      context.setLineDash([5, 5]);
      context.strokeStyle = WALL_MAP.rangeRing;
      for (const meters of SCHEMATIC.rangeRingsMeters) {
        context.beginPath();
        context.arc(landing.x, landing.y, meters * 100 * scale, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
      context.fillStyle = "#8bbbd7";
      context.font = "12px ui-monospace, Consolas, monospace";
      context.fillText("LANDING-SITE REFERENCE · NOT TERRAIN DATA", 18, 22);
      context.fillText("N ↑", width - 48, 22);
      context.fillText("E →", width - 48, 40);

      const points = [];
      const path = data.roverPathRef?.current ?? [];
      const replayStart = data.now - TELEMETRY_CONFIG.replayWindowMs;
      const displayedPath = path.filter(
        (point) =>
          point.eventTimeMs >= replayStart && point.eventTimeMs <= data.now,
      );
      for (let index = 1; index < displayedPath.length; index += 1) {
        const previous = displayedPath[index - 1];
        const current = displayedPath[index];
        const from = wallMapPoint(previous, viewport, MAP_SCALE);
        const to = wallMapPoint(current, viewport, MAP_SCALE);
        if (!from || !to) continue;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.strokeStyle = "#35c9ff";
        context.globalAlpha = Math.max(
          0.12,
          1 - getAge(current, current.receivedAt, data.now) / WALL_MAP.pathFadeMs,
        );
        context.lineWidth = 2;
        context.stroke();
      }
      context.globalAlpha = 1;

      for (const hazard of data.hazards) {
        const point = wallMapPoint(hazard, viewport, MAP_SCALE);
        if (!point) continue;
        const age = getAge(hazard, hazard.receivedAt, data.now);
        const visuals = ageVisuals(hazard.class, age);
        const radius = uncertaintyRadiusCm(
          hazard,
          age / DASHBOARD_CONFIG.wallDisplay.millisecondsPerSecond,
          data.roverPosition,
        ) * scale;
        context.save();
        context.globalAlpha = visuals.opacity;
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fillStyle = visuals.color;
        context.globalAlpha = visuals.opacity * 0.12;
        context.fill();
        context.globalAlpha = visuals.opacity * 0.65;
        context.strokeStyle = visuals.color;
        context.lineWidth = 1.5;
        if (visuals.stage === "STALE" || visuals.stage === "EXPIRED") {
          context.setLineDash([4, 4]);
        }
        context.stroke();
        context.setLineDash([]);
        context.globalAlpha = visuals.opacity;
        context.beginPath();
        context.arc(point.x, point.y, WALL_MAP.markerRadiusPx, 0, Math.PI * 2);
        context.fillStyle = visuals.color;
        context.fill();
        if (hazard.id === data.selectedHazardId) {
          context.beginPath();
          context.arc(point.x, point.y, WALL_MAP.selectedRadiusPx, 0, Math.PI * 2);
          context.strokeStyle = "#ffffff";
          context.lineWidth = 2;
          context.stroke();
        }
        context.font = "12px ui-monospace, Consolas, monospace";
        context.fillStyle = "#e5f2ff";
        context.fillText(
          `${hazard.class.toUpperCase()} · ${formatWallAge(age)}${data.simulated ? " · SIM" : ""}`,
          point.x + 10,
          point.y - 8,
        );
        context.restore();
        points.push({ hazard, screenX: point.x, screenY: point.y });
      }
      hitTargets = points;

      if (data.roverPosition) {
        const point = wallMapPoint(data.roverPosition, viewport, MAP_SCALE);
        const roverAge = getAge(
          data.roverPosition,
          data.roverPosition.receivedAt,
          data.now,
        );
        const roverRadius =
          roverUncertaintyRadiusCm(roverAge) * scale;
        context.beginPath();
        context.arc(point.x, point.y, roverRadius, 0, Math.PI * 2);
        context.fillStyle = WALL_MAP.roverUncertaintyFill;
        context.fill();
        context.strokeStyle = WALL_MAP.roverUncertaintyStroke;
        context.setLineDash([5, 4]);
        context.stroke();
        context.setLineDash([]);
        context.save();
        context.translate(point.x, point.y);
        context.rotate(Math.PI / 4);
        context.fillStyle = "#55df91";
        context.fillRect(
          -WALL_MAP.markerRadiusPx,
          -WALL_MAP.markerRadiusPx,
          WALL_MAP.markerRadiusPx * 2,
          WALL_MAP.markerRadiusPx * 2,
        );
        context.restore();
      }
      context.beginPath();
      context.arc(landing.x, landing.y, 4, 0, Math.PI * 2);
      context.fillStyle = "#e5f2ff";
      context.fill();
      if (!data.hazards.length && !data.roverPosition) {
        context.fillStyle = "#a9bfd6";
        context.font = "16px ui-monospace, Consolas, monospace";
        context.fillText("no data · waiting for telemetry", 24, height - 28);
      }
      if (data.linkState === "LOS" || data.linkState === "BLACKOUT") {
        context.fillStyle = "rgba(3, 8, 18, 0.48)";
        context.fillRect(0, 0, width, height);
      }
    };

    const onClick = (event) => {
      const bounds = canvas.getBoundingClientRect();
      const hazard = nearestWallHazard(
        hitTargets,
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        WALL_MAP.hitRadiusPx,
      );
      if (hazard) latest.current.onSelectHazard(hazard.id);
    };
    canvas.addEventListener("click", onClick);
    frame = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(frame);
      canvas.removeEventListener("click", onClick);
    };
  }, [active]);

  const lost = linkState === "LOS" || linkState === "BLACKOUT";
  return h(
    "div",
    { className: "hud-wall-map" },
    h("canvas", {
      ref: canvasRef,
      className: "hud-map-canvas",
      "aria-label": "Offline hazard map. Click a marker to select a hazard.",
      role: "img",
    }),
    lost
      ? h(
          "div",
          { className: "hud-map-los-banner", role: "status" },
          `LOS - data frozen since ${missionTimeLabel(frozenAt)}`,
        )
      : null,
  );
}

function useWallCanvasScale() {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const resize = () => {
      setScale(
        Math.min(window.innerWidth / WIDTH, window.innerHeight / HEIGHT),
      );
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return scale;
}

function panel(title, content, className = "") {
  return h(
    "section",
    { className: `hud-panel ${className}`, key: title },
    h("span", { className: "hud-corner hud-corner-tl", "aria-hidden": "true" }),
    h("span", { className: "hud-corner hud-corner-tr", "aria-hidden": "true" }),
    h("span", { className: "hud-corner hud-corner-bl", "aria-hidden": "true" }),
    h("span", { className: "hud-corner hud-corner-br", "aria-hidden": "true" }),
    h("h2", { className: "hud-panel-title" }, title),
    content,
  );
}

function DonutGauge({ label, value, tooltip }) {
  const hasValue = Number.isFinite(value);
  const safeValue = hasValue ? Math.max(0, Math.min(100, value)) : 0;
  return h(
    "div",
    {
      className: "hud-gauge",
      title: tooltip,
      role: "img",
      "aria-label": `${label}: ${hasValue ? `${safeValue.toFixed(1)} percent` : "no data"}`,
    },
    h(
      "svg",
      { viewBox: "0 0 160 160", "aria-hidden": "true" },
      h("circle", {
        className: "hud-gauge-track",
        cx: 80,
        cy: 80,
        r: 68,
      }),
      hasValue
        ? h("circle", {
            className: "hud-gauge-value",
            cx: 80,
            cy: 80,
            r: 68,
            strokeDasharray: `${(safeValue / 100) * GAUGE_CIRCUMFERENCE} ${GAUGE_CIRCUMFERENCE}`,
          })
        : null,
      h(
        "text",
        { className: "hud-gauge-number", x: 80, y: 86 },
        hasValue ? `${safeValue.toFixed(1)}%` : "—",
      ),
    ),
    h("strong", null, label),
    !hasValue ? h("span", { className: "hud-no-data" }, "no data") : null,
  );
}

function KpiTile({ label, value, className = "" }) {
  return h(
    "div",
    { className: `hud-kpi ${className}` },
    h("span", null, label),
    h("strong", null, value),
  );
}

function StatisticsTable({ rows, hasHazards }) {
  return h(
    "div",
    { className: "hud-table-wrap" },
    h(
      "table",
      { className: "hud-statistics" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          ...["CLASS", "COUNT", "AVG CONF", "AVG SIGMA", "OLDEST AGE", "NEAREST"].map(
            (label) => h("th", { key: label }, label),
          ),
        ),
      ),
      h(
        "tbody",
        null,
        ...rows.map((row) => {
          const populated = row.count > 0;
          return h(
            "tr",
            { key: row.value, className: row.value === "total" ? "hud-total-row" : "" },
            h("th", { scope: "row" }, row.label),
            h("td", null, hasHazards ? row.count : "no data"),
            h("td", null, populated ? `${formatWallValue(row.averageConfidence, 2)} / 7` : "no data"),
            h("td", null, populated ? formatWallMeters(row.averageSigmaCm) : "no data"),
            h("td", null, populated ? formatWallAge(row.oldestAgeMs) : "no data"),
            h("td", null, populated ? formatWallMeters(row.nearestDistanceCm) : "no data"),
          );
        }),
      ),
    ),
  );
}

function WallDisplay({
  active,
  onBack,
  missionTimeMs,
  linkState,
  lastPacketAgeMs,
  serverConnected,
  hazards,
  history,
  link,
  now,
  roverPosition,
  simulated,
  mapViewRef,
  roverPathRef,
  selectedHazardId,
  onSelectHazard,
}) {
  const scale = useWallCanvasScale();
  const [derivedTick, setDerivedTick] = useState(0);
  const [showF11Hint, setShowF11Hint] = useState(false);
  const hintWasShown = useRef(false);
  const backButtonRef = useRef(null);
  const previousLinkState = useRef(linkState);
  const frozenAt = useRef(
    linkState === "LOS" || linkState === "BLACKOUT" ? missionTimeMs : null,
  );
  const latestInputs = useRef(null);
  latestInputs.current = {
    hazards,
    history,
    link,
    now,
    lastPacketAgeMs,
    roverPosition,
  };
  if (linkState === "LOS" || linkState === "BLACKOUT") {
    if (previousLinkState.current !== "LOS" && previousLinkState.current !== "BLACKOUT") {
      frozenAt.current = missionTimeMs;
    }
  } else {
    frozenAt.current = null;
  }
  previousLinkState.current = linkState;
  useEffect(() => {
    const timer = window.setInterval(
      () => setDerivedTick((tick) => tick + 1),
      DASHBOARD_CONFIG.wallDisplay.derivedRefreshMs,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!active || hintWasShown.current) return undefined;
    hintWasShown.current = true;
    try {
      if (window.sessionStorage.getItem("crater-wall-f11-hint-shown")) return undefined;
      window.sessionStorage.setItem("crater-wall-f11-hint-shown", "true");
    } catch {
      // Keep the one-time hint scoped to this mounted dashboard when storage is unavailable.
    }
    setShowF11Hint(true);
    const timer = window.setTimeout(
      () => setShowF11Hint(false),
      DASHBOARD_CONFIG.wallDisplay.f11HintDurationMs,
    );
    return () => window.clearTimeout(timer);
  }, [active]);
  useEffect(() => {
    if (active) backButtonRef.current?.focus();
  }, [active]);

  const metrics = useMemo(
    () => createWallDisplayMetrics(latestInputs.current),
    [derivedTick],
  );
  const gaugeItems = [
    ["DELIVERY RATE", metrics.gauges.deliveryPercent, "Received / expected packets from the current link counters."],
    ["10 S PACKET LOSS", metrics.gauges.windowedLossPercent, "Computed from expected and received counter deltas across the most recent 10 seconds."],
    ["FRESH HAZARDS", metrics.gauges.freshSharePercent, "Fresh detections divided by all displayed detections."],
    [
      "LINK QUALITY",
      metrics.gauges.linkQualityPercent,
      `Formula: 100 − 10 s windowed loss percentage − (${DASHBOARD_CONFIG.wallDisplay.qualityAgePenaltyPointsPerSecond} × last-packet age in seconds), clamped to 0–100.`,
    ],
  ];
  const statusClass =
    linkState === "AOS" ? "nominal" : linkState === "DEGRADED" ? "warning" : "alarm";
  const statusWord = linkState === "BLACKOUT" ? "LOS · BLACKOUT" : linkState;
  const packetTone = !Number.isFinite(lastPacketAgeMs)
    ? "unknown"
    : lastPacketAgeMs < NOMINAL_PACKET_MS
      ? "nominal"
      : lastPacketAgeMs <= WARNING_PACKET_MS
        ? "warning"
        : "alarm";
  const ageCounts = ["FRESH", "AGING", "STALE", "EXPIRED"];
  let missionClock = "MISSION CLOCK  no data";
  if (Number.isFinite(missionTimeMs)) {
    const hours = Math.floor(missionTimeMs / millisecondsPerHour);
    const minutes = Math.floor(
      (missionTimeMs % millisecondsPerHour) / millisecondsPerMinute,
    );
    const seconds = Math.floor(
      (missionTimeMs % millisecondsPerMinute) /
        DASHBOARD_CONFIG.wallDisplay.millisecondsPerSecond,
    );
    missionClock = `MISSION CLOCK  T+${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return h(
    "div",
    {
      className: `wall-display-viewport${active ? " is-active" : ""}`,
      "aria-hidden": active ? undefined : "true",
    },
    h(
      "div",
      {
        className: "wall-display-canvas",
        style: { transform: `translate(-50%, -50%) scale(${scale})` },
      },
      h(
        "header",
        { className: "hud-header" },
        h(
          "div",
          { className: "hud-brand" },
          h("span", { className: "hud-logo", "aria-hidden": "true" }, "C"),
          h("strong", null, "C.R.A.T.E.R. MISSION CONTROL"),
        ),
        h("span", { className: `hud-clock${Number.isFinite(missionTimeMs) ? "" : " hud-no-data"}` }, missionClock),
        h(
          "span",
          { className: `hud-status hud-status-${statusClass}` },
          h("i", { "aria-hidden": "true" }),
          statusWord,
        ),
        h(
          "span",
          { className: `hud-packet hud-packet-${packetTone}` },
          Number.isFinite(lastPacketAgeMs) ? `LAST PACKET ${formatWallAge(lastPacketAgeMs)} AGO` : "LAST PACKET no data",
        ),
        h(
          "span",
          { className: `hud-server ${serverConnected ? "nominal" : "alarm"}` },
          serverConnected ? "SERVER CONNECTED" : "SERVER DISCONNECTED",
        ),
        h("button", { ref: backButtonRef, type: "button", className: "hud-back-button", onClick: onBack }, "Back to operator view (W)"),
      ),
      simulated
        ? h(
            "div",
            { className: "hud-simulation-banner", role: "status" },
            "SIMULATION - not rover data",
            h("span", { className: "hud-sim-tag" }, "SIM"),
          )
        : null,
      h(
        "main",
        { className: "hud-grid", "aria-label": "Wall display telemetry" },
        panel(
          "ROVER AND CAMERA SCHEMATIC",
          h(RoverSchematic, {
            hazards,
            selectedHazardId,
            roverPosition,
            now,
            simulated,
          }),
          "hud-schematic-panel",
        ),
        panel(
          "TELEMETRY SNAPSHOT · LIVE DATA",
          h(
            React.Fragment,
            null,
            h(
              "div",
              { className: "hud-gauges" },
              ...gaugeItems.map(([label, value, tooltip]) =>
                h(DonutGauge, { key: label, label, value, tooltip }),
              ),
            ),
            h(
              "div",
              { className: "hud-kpi-grid" },
              ...DETECTION_CLASSES.filter(({ value }) => value !== "unknown").map(
                ({ value, label }) =>
                  h(KpiTile, {
                    key: value,
                    label: `${label.toUpperCase()} DETECTIONS`,
                    value: metrics.hasHazards
                      ? metrics.hazardClassCounts[value]
                      : "no data",
                    className: `hud-class-${value}`,
                  }),
              ),
              ...ageCounts.map((stage) =>
                h(KpiTile, {
                  key: stage,
                  label: `${stage} HAZARDS`,
                  value: metrics.hasHazards
                    ? metrics.stageCounts[stage]
                    : "no data",
                  className: `hud-age-${stage.toLowerCase()}`,
                }),
              ),
            ),
          ),
          "hud-metrics-panel",
        ),
        panel(
          "PER-CLASS DETECTION STATISTICS",
          h(StatisticsTable, {
            rows: metrics.statistics,
            hasHazards: metrics.hasHazards,
          }),
          "hud-statistics-panel",
        ),
        panel(
          "HAZARD MAP",
          h(WallMapCanvas, {
            active,
            hazards,
            roverPathRef,
            roverPosition,
            selectedHazardId,
            onSelectHazard,
            mapViewRef,
            now,
            simulated,
            linkState,
            frozenAt: frozenAt.current,
          }),
          "hud-map-panel",
        ),
      ),
      showF11Hint
        ? h("div", { className: "hud-f11-hint", role: "status" }, "Press F11 for fullscreen. Press W to return.")
        : null,
    ),
  );
}

export default WallDisplay;
