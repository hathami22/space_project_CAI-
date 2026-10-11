import {
  ageVisuals,
  canvasToCm,
  cmToCanvas,
  DETECTION_CLASSES,
  formatAge,
  getAge,
  roverUncertaintyRadiusCm,
  uncertaintyComponents,
  uncertaintyRadiusCm,
  TELEMETRY_CONFIG,
} from "../lib/telemetry.js";

const { memo, useEffect, useRef, useState } = React;
const h = React.createElement;

const SCALE = TELEMETRY_CONFIG.map.pixelsPerCm;
const GRID_CM = TELEMETRY_CONFIG.map.gridSpacingCm;
const MIN_ZOOM = TELEMETRY_CONFIG.map.minZoom;
const MAX_ZOOM = TELEMETRY_CONFIG.map.maxZoom;
const REDRAW_INTERVAL_MS = TELEMETRY_CONFIG.map.redrawIntervalMs;
const REPLAY_WINDOW_MS = TELEMETRY_CONFIG.replayWindowMs;

function classFilterKey(className) {
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

function mapFont(size) {
  const rootSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const scale = Number.isFinite(rootSize) ? rootSize / 16 : 1;
  return `${size * scale}px ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace`;
}

function pointOnMap(point, originX, originY, zoom, panX, panY) {
  const canvasPoint = cmToCanvas(
    point.x_cm,
    point.y_cm,
    originX,
    originY,
    SCALE * zoom,
  );
  return {
    x: canvasPoint.x + panX,
    y: canvasPoint.y + panY,
  };
}

function canvasPoint(point, canvas, camera, rover) {
  const bounds = canvas.getBoundingClientRect();
  const panX = camera.followRover && rover
    ? -rover.x_cm * SCALE * camera.zoom
    : camera.panX;
  const panY = camera.followRover && rover
    ? rover.y_cm * SCALE * camera.zoom
    : camera.panY;
  return pointOnMap(
    point,
    bounds.width / 2,
    bounds.height / 2,
    camera.zoom,
    panX,
    panY,
  );
}

function drawMarker(context, marker, point, rover, ageMs, visuals, selected, showUncertainty, zoom) {
  const palette = getComputedStyle(context.canvas);
  const mapBackground = palette.getPropertyValue("--map-background").trim();
  const textColor = palette.getPropertyValue("--text").trim();
  context.save();
  context.globalAlpha = visuals.opacity;

  if (showUncertainty) {
    const radiusCm = uncertaintyRadiusCm(marker, ageMs / 1000, rover);
    context.beginPath();
    context.arc(point.x, point.y, radiusCm * SCALE * zoom, 0, Math.PI * 2);
    context.fillStyle = visuals.color;
    context.globalAlpha = visuals.opacity * 0.12;
    context.fill();
    context.globalAlpha = visuals.opacity * 0.55;
    context.strokeStyle = visuals.color;
    context.lineWidth = 1;
    if (visuals.stage === "STALE" || visuals.stage === "EXPIRED") {
      context.setLineDash([3, 4]);
    }
    context.stroke();
    context.setLineDash([]);
  }

  context.globalAlpha = visuals.opacity;
  context.beginPath();
  context.arc(point.x, point.y, Math.max(3, 5 * Math.min(zoom, 1.5)), 0, Math.PI * 2);
  context.fillStyle = visuals.color;
  context.fill();
  context.strokeStyle =
    visuals.stage === "STALE" || visuals.stage === "EXPIRED"
      ? visuals.color
      : mapBackground;
  context.lineWidth = 1.5;
  if (visuals.stage === "STALE" || visuals.stage === "EXPIRED") {
    context.setLineDash([3, 2]);
  }
  context.stroke();
  context.setLineDash([]);

  if (selected) {
    context.beginPath();
    context.arc(point.x, point.y, 10, 0, Math.PI * 2);
    context.strokeStyle = textColor;
    context.lineWidth = 2;
    context.stroke();
  }
  context.restore();
}

const MapCanvas = memo(function MapCanvas({
  hazardsRef,
  roverPathRef,
  selectedHazardId,
  onSelectHazard,
  signalLost,
  link,
  clockNow,
  viewTimeMs,
  sliderMinMs,
  sliderMaxMs,
  paused,
  onTogglePause,
  onSetReplayTime,
  followRover,
  onToggleFollow,
  classFilters,
  onToggleClass,
  hideExpired,
  onToggleHideExpired,
  showUncertainty,
  onToggleUncertainty,
  showRoverPath,
  onToggleRoverPath,
  showAxisChecks,
  onToggleAxisChecks,
  onToggleDebug,
  darkMode,
  displayBanner,
  simulationActive,
  mapViewRef,
}) {
  const canvasRef = useRef(null);
  const wrapperRef = useRef(null);
  const bannerAgeRef = useRef(null);
  const hoverMarkerIdRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [zoomDisplay, setZoomDisplay] = useState(1);
  const [cursorCoordinates, setCursorCoordinates] = useState("X -- m · Y -- m");
  const cameraRef = useRef({
    zoom: 1,
    panX: 0,
    panY: 0,
    followRover: false,
    drag: null,
  });
  const propsRef = useRef(null);

  propsRef.current = {
    hazardsRef,
    roverPathRef,
    selectedHazardId,
    onSelectHazard,
    signalLost,
    link,
    clockNow,
    viewTimeMs,
    sliderMinMs,
    sliderMaxMs,
    paused,
    classFilters,
    hideExpired,
    showUncertainty,
    showRoverPath,
    showAxisChecks,
    darkMode,
    simulationActive,
    onToggleFollow,
    onTogglePause,
    onSetReplayTime,
    onToggleAxisChecks,
    onToggleDebug,
    mapViewRef,
  };
  cameraRef.current.followRover = followRover;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return undefined;

    let animationFrame;
    let lastDrawAt = 0;

    const draw = (frameTime) => {
      animationFrame = window.requestAnimationFrame(draw);
      if (frameTime - lastDrawAt < REDRAW_INTERVAL_MS) return;
      lastDrawAt = frameTime;

      const current = propsRef.current;
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
      const palette = getComputedStyle(canvas);
      const color = (name) => palette.getPropertyValue(name).trim();

      const width = bounds.width;
      const height = bounds.height;
      const camera = cameraRef.current;
      const now = current.viewTimeMs;
      const roverPath = current.roverPathRef.current;
      const replayStart = now - REPLAY_WINDOW_MS;
      const displayedPath = roverPath.filter(
        (point) => point.eventTimeMs >= replayStart && point.eventTimeMs <= now,
      );
      const rover = displayedPath[displayedPath.length - 1] ?? null;
      const panX = camera.followRover && rover
        ? -rover.x_cm * SCALE * camera.zoom
        : camera.panX;
      const panY = camera.followRover && rover
        ? rover.y_cm * SCALE * camera.zoom
        : camera.panY;
      if (current.mapViewRef) {
        current.mapViewRef.current = {
          zoom: camera.zoom,
          panX: width ? panX / width : 0,
          panY: height ? panY / height : 0,
          followRover: camera.followRover,
        };
      }
      const originX = width / 2;
      const originY = height / 2;
      const gridStep = GRID_CM * SCALE * camera.zoom;
      const spanX =
        Math.ceil((width / 2 + Math.abs(panX)) / gridStep) * GRID_CM +
        GRID_CM;
      const spanY =
        Math.ceil((height / 2 + Math.abs(panY)) / gridStep) * GRID_CM +
        GRID_CM;

      if (bannerAgeRef.current) {
        const age = current.link?.since_last_rx_ms;
        bannerAgeRef.current.textContent = Number.isFinite(age)
          ? formatAge(age)
          : "Last contact unknown";
      }

      context.clearRect(0, 0, width, height);
      context.fillStyle = color("--map-background");
      context.fillRect(0, 0, width, height);
      context.lineWidth = 1;
      context.font = mapFont(10);
      context.textAlign = "center";
      context.textBaseline = "top";

      for (let cm = -spanX; cm <= spanX; cm += GRID_CM) {
        const x = originX + panX + cm * SCALE * camera.zoom;
        context.beginPath();
        context.strokeStyle = current.darkMode
          ? cm === 0
            ? color("--map-axis")
            : color("--grid")
          : cm === 0
            ? color("--map-axis")
            : color("--grid");
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
        if (cm !== 0 && cm % 1000 === 0) {
          context.fillStyle = color("--muted");
          context.fillText(`${cm / 100} m`, x, originY + panY + 7);
        }
      }

      context.textAlign = "left";
      for (let cm = -spanY; cm <= spanY; cm += GRID_CM) {
        const y = originY + panY - cm * SCALE * camera.zoom;
        context.beginPath();
        context.strokeStyle = current.darkMode
          ? cm === 0
            ? color("--map-axis")
            : color("--grid")
          : cm === 0
            ? color("--map-axis")
            : color("--grid");
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
        if (cm !== 0 && cm % 1000 === 0) {
          context.fillStyle = color("--muted");
          context.fillText(`${cm / 100} m`, originX + panX + 7, y + 3);
        }
      }

      const visiblePath = current.showRoverPath ? displayedPath : [];
      if (visiblePath.length > 1) {
        context.beginPath();
        visiblePath.slice(1).forEach((point, index) => {
          const previous = visiblePath[index];
          const age = Math.max(0, (now - point.receivedAt) / 1000);
          const screen = pointOnMap(
            previous,
            originX,
            originY,
            camera.zoom,
            panX,
            panY,
          );
          const nextScreen = pointOnMap(
            point,
            originX,
            originY,
            camera.zoom,
            panX,
            panY,
          );
          context.beginPath();
          context.moveTo(screen.x, screen.y);
          context.lineTo(nextScreen.x, nextScreen.y);
          context.strokeStyle = color("--info");
          context.globalAlpha = Math.max(0.12, 1 - age / 30);
          context.stroke();
        });
        context.globalAlpha = 1;
        context.lineWidth = 1;
      }

      const visibleMarkers = current.hazardsRef.current.filter((marker) => {
        if (marker.eventTimeMs < replayStart || marker.eventTimeMs > now) return false;
        if (!current.classFilters[classFilterKey(marker.class)]) return false;
        const age = getAge(marker, marker.receivedAt, now);
        return (
          age <= TELEMETRY_CONFIG.ageMs.remove &&
          (!current.hideExpired || age <= TELEMETRY_CONFIG.ageMs.expired)
        );
      });
      const latestIds = new Set(
        [...visibleMarkers]
          .sort((a, b) => b.eventTimeMs - a.eventTimeMs)
          .slice(0, 15)
          .map((marker) => marker.id),
      );

      for (const marker of visibleMarkers) {
        const age = getAge(marker, marker.receivedAt, now);
        const ageStyle = ageVisuals(marker.class, age);
        const visuals = {
          ...ageStyle,
          color:
            ageStyle.stage === "FRESH" || ageStyle.stage === "AGING"
              ? color(`--hazard-${classFilterKey(marker.class)}`)
              : color("--stale"),
        };
        const point = pointOnMap(
          marker,
          originX,
          originY,
          camera.zoom,
          panX,
          panY,
        );
        drawMarker(
          context,
          marker,
          point,
          rover,
          age,
          visuals,
          marker.id === current.selectedHazardId,
          current.showUncertainty,
          camera.zoom,
        );

        if (
          latestIds.has(marker.id) ||
          hoverMarkerIdRef.current === marker.id
        ) {
          context.save();
          context.globalAlpha = Math.max(0.45, visuals.opacity);
          context.fillStyle = visuals.color;
          context.font = mapFont(10);
          context.textAlign = "left";
          context.textBaseline = "middle";
          context.fillText(
            current.simulationActive
              ? `SIM · seen ${formatAge(age)}`
              : `seen ${formatAge(age)}`,
            point.x + 9,
            point.y - 8,
          );
          context.restore();
        }
      }

      const origin = pointOnMap(
        { x_cm: 0, y_cm: 0 },
        originX,
        originY,
        camera.zoom,
        panX,
        panY,
      );
      context.beginPath();
      context.moveTo(origin.x - 8, origin.y);
      context.lineTo(origin.x + 8, origin.y);
      context.moveTo(origin.x, origin.y - 8);
      context.lineTo(origin.x, origin.y + 8);
      context.strokeStyle = color("--text");
      context.lineWidth = 1;
      context.stroke();
      context.arc(origin.x, origin.y, 2.5, 0, Math.PI * 2);
      context.fillStyle = color("--text");
      context.fill();
      context.font = mapFont(9);
      context.textAlign = "left";
      context.textBaseline = "bottom";
      context.fillStyle = color("--text");
      context.fillText("LANDING SITE", origin.x + 10, origin.y - 8);

      if (rover) {
        const screenRover = pointOnMap(
          rover,
          originX,
          originY,
          camera.zoom,
          panX,
          panY,
        );
        const roverAge = getAge(rover, rover.receivedAt, now);
        const roverRadiusCm = roverUncertaintyRadiusCm(roverAge);
        context.beginPath();
        context.arc(
          screenRover.x,
          screenRover.y,
          roverRadiusCm * SCALE * camera.zoom,
          0,
          Math.PI * 2,
        );
        context.fillStyle = color("--info");
        context.globalAlpha = 0.08;
        context.fill();
        context.globalAlpha = 0.65;
        context.strokeStyle = color("--info");
        context.lineWidth = 1;
        context.setLineDash([4, 3]);
        context.stroke();
        context.setLineDash([]);
        context.globalAlpha = 1;
        context.font = mapFont(9);
        context.textAlign = "left";
        context.textBaseline = "top";
        context.fillStyle = color("--info");
        context.fillText(
          `ROVER POSITION ±${(roverRadiusCm / 100).toFixed(2)} m (ASSUMED MAX SPEED)`,
          screenRover.x + 10,
          screenRover.y + 10,
        );
        context.save();
        context.translate(screenRover.x, screenRover.y);
        const previousRover = displayedPath.at(-2);
        if (previousRover) {
          const previousScreen = pointOnMap(
            previousRover,
            originX,
            originY,
            camera.zoom,
            panX,
            panY,
          );
          const angle = Math.atan2(
            screenRover.y - previousScreen.y,
            screenRover.x - previousScreen.x,
          ) + Math.PI / 2;
          context.rotate(angle);
          context.beginPath();
          context.moveTo(0, -14);
          context.lineTo(0, -8);
          context.strokeStyle = color("--nominal");
          context.lineWidth = 1.5;
          context.stroke();
        }
        context.beginPath();
        context.moveTo(0, -9);
        context.lineTo(7, 7);
        context.lineTo(-7, 7);
        context.closePath();
        context.fillStyle = color("--nominal");
        context.fill();
        context.strokeStyle = color("--map-background");
        context.lineWidth = 1.5;
        context.stroke();
        context.restore();
      }

      if (current.showAxisChecks) {
        const references = [
          { x_cm: 500, y_cm: 0, label: "E" },
          { x_cm: 0, y_cm: 500, label: "N" },
          { x_cm: -500, y_cm: 0, label: "W" },
          { x_cm: 0, y_cm: -500, label: "S" },
        ];
        context.save();
        context.font = mapFont(10);
        context.textAlign = "center";
        context.textBaseline = "middle";
        for (const reference of references) {
          const point = pointOnMap(
            reference,
            originX,
            originY,
            camera.zoom,
            panX,
            panY,
          );
          context.beginPath();
          context.arc(point.x, point.y, 7, 0, Math.PI * 2);
          context.strokeStyle = color("--warning");
          context.lineWidth = 1.5;
          context.stroke();
          context.fillStyle = color("--warning");
          context.fillText(reference.label, point.x, point.y);
        }
        context.restore();
      }

      if (current.signalLost) {
        context.fillStyle = color("--signal-overlay");
        context.fillRect(0, 0, width, height);
      }
    };

    const markerAt = (event) => {
      const current = propsRef.current;
      const bounds = canvas.getBoundingClientRect();
      const camera = cameraRef.current;
      const now = current.viewTimeMs;
      const start = now - REPLAY_WINDOW_MS;
      const rover = current.roverPathRef.current
        .filter((point) => point.eventTimeMs >= start && point.eventTimeMs <= now)
        .slice(-1)[0];
      let nearest = null;
      let nearestDistance = Infinity;

      for (const marker of current.hazardsRef.current) {
        if (marker.eventTimeMs < start || marker.eventTimeMs > now) continue;
        if (!current.classFilters[classFilterKey(marker.class)]) continue;
        const age = getAge(marker, marker.receivedAt, now);
        if (
          age > TELEMETRY_CONFIG.ageMs.remove ||
          (current.hideExpired && age > TELEMETRY_CONFIG.ageMs.expired)
        ) {
          continue;
        }
        const screen = canvasPoint(marker, canvas, camera, rover);
        const distance = Math.hypot(
          screen.x - (event.clientX - bounds.left),
          screen.y - (event.clientY - bounds.top),
        );
        const hitRadius = current.showUncertainty
          ? Math.max(
              14,
              uncertaintyRadiusCm(marker, age / 1000, rover) *
                SCALE *
                camera.zoom,
            )
          : 14;
        if (distance <= hitRadius && distance < nearestDistance) {
          nearest = marker;
          nearestDistance = distance;
        }
      }
      return nearest;
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      cameraRef.current.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: cameraRef.current.panX,
        panY: cameraRef.current.panY,
        moved: false,
      };
    };
    const onPointerMove = (event) => {
      const camera = cameraRef.current;
      const drag = camera.drag;
      const bounds = canvas.getBoundingClientRect();
      const current = propsRef.current;
      const replayStart = current.viewTimeMs - REPLAY_WINDOW_MS;
      const rover = current.roverPathRef.current
        .filter(
          (point) =>
            point.eventTimeMs >= replayStart &&
            point.eventTimeMs <= current.viewTimeMs,
        )
        .slice(-1)[0];
      const panX = camera.followRover && rover
        ? -rover.x_cm * SCALE * camera.zoom
        : camera.panX;
      const panY = camera.followRover && rover
        ? rover.y_cm * SCALE * camera.zoom
        : camera.panY;
      const world = canvasToCm(
        event.clientX - bounds.left - panX,
        event.clientY - bounds.top - panY,
        bounds.width / 2,
        bounds.height / 2,
        SCALE * camera.zoom,
      );
      setCursorCoordinates(
        `X ${(world.x_cm / 100).toFixed(2)} m · Y ${(world.y_cm / 100).toFixed(2)} m`,
      );
      if (drag && drag.pointerId === event.pointerId) {
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (drag.moved) {
          camera.panX = drag.panX + dx;
          camera.panY = drag.panY + dy;
          camera.followRover = false;
          propsRef.current.onToggleFollow(false);
          setHover(null);
          hoverMarkerIdRef.current = null;
          canvas.style.cursor = "grabbing";
        }
        return;
      }

      const marker = markerAt(event);
      hoverMarkerIdRef.current = marker?.id ?? null;
      canvas.style.cursor = marker ? "pointer" : "grab";
      if (marker) {
        const bounds = canvas.getBoundingClientRect();
        const nextHover = {
          marker,
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        };
        setHover((current) =>
          current?.marker.id === marker.id &&
          Math.abs(current.x - nextHover.x) < 4 &&
          Math.abs(current.y - nextHover.y) < 4
            ? current
            : nextHover,
        );
      } else {
        setHover(null);
      }
    };
    const onPointerUp = (event) => {
      const drag = cameraRef.current.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      cameraRef.current.drag = null;
      if (!drag.moved) {
        propsRef.current.onSelectHazard(markerAt(event)?.id ?? null);
      }
      canvas.style.cursor = "grab";
    };
    const onPointerCancel = () => {
      cameraRef.current.drag = null;
      canvas.style.cursor = "grab";
    };
    const onPointerLeave = () => {
      if (cameraRef.current.drag) return;
      hoverMarkerIdRef.current = null;
      setHover(null);
      setCursorCoordinates("X -- m · Y -- m");
    };
    const onWheel = (event) => {
      event.preventDefault();
      const camera = cameraRef.current;
      const bounds = canvas.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      const previousZoom = camera.zoom;
      const nextZoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, previousZoom * Math.exp(-event.deltaY * 0.001)),
      );
      const replayStart = propsRef.current.viewTimeMs - REPLAY_WINDOW_MS;
      const rover = propsRef.current.roverPathRef.current
        .filter(
          (point) =>
            point.eventTimeMs >= replayStart &&
            point.eventTimeMs <= propsRef.current.viewTimeMs,
        )
        .slice(-1)[0];
      const oldPanX =
        camera.followRover && rover
          ? -rover.x_cm * SCALE * previousZoom
          : camera.panX;
      const oldPanY =
        camera.followRover && rover
          ? rover.y_cm * SCALE * previousZoom
          : camera.panY;
      const world = canvasToCm(
        pointerX - oldPanX,
        pointerY - oldPanY,
        bounds.width / 2,
        bounds.height / 2,
        SCALE * previousZoom,
      );
      camera.zoom = nextZoom;
      if (!camera.followRover) {
        camera.panX = pointerX - bounds.width / 2 - world.x_cm * SCALE * nextZoom;
        camera.panY = pointerY - bounds.height / 2 + world.y_cm * SCALE * nextZoom;
      }
      setZoomDisplay(nextZoom);
    };
    const onKeyDown = (event) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.code === "Space") {
        if (target instanceof HTMLElement && target.tagName === "BUTTON") return;
        event.preventDefault();
        propsRef.current.onTogglePause();
      } else if (event.key.toLowerCase() === "r") {
        resetView();
      } else if (event.key.toLowerCase() === "f") {
        propsRef.current.onToggleFollow(!cameraRef.current.followRover);
      } else if (event.key.toLowerCase() === "k") {
        propsRef.current.onToggleAxisChecks();
      } else if (event.key.toLowerCase() === "d") {
        propsRef.current.onToggleDebug();
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    canvas.style.cursor = "grab";
    animationFrame = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const resetView = () => {
    cameraRef.current.zoom = 1;
    cameraRef.current.panX = 0;
    cameraRef.current.panY = 0;
    cameraRef.current.followRover = false;
    propsRef.current.onToggleFollow(false);
    setZoomDisplay(1);
  };
  const hoveredIsVisible =
    hover &&
    hazardsRef.current.some((marker) => {
      const age = getAge(marker, marker.receivedAt, viewTimeMs);
      return (
        marker.id === hover.marker.id &&
        marker.eventTimeMs >= viewTimeMs - REPLAY_WINDOW_MS &&
        marker.eventTimeMs <= viewTimeMs &&
        classFilters[classFilterKey(marker.class)] &&
        age <= TELEMETRY_CONFIG.ageMs.remove &&
        (!hideExpired || age <= TELEMETRY_CONFIG.ageMs.expired)
      );
    });
  const tooltipRover =
    roverPathRef.current
      .filter(
        (point) =>
          point.eventTimeMs >= viewTimeMs - REPLAY_WINDOW_MS &&
          point.eventTimeMs <= viewTimeMs,
      )
      .slice(-1)[0] ?? null;
  const tooltipUncertainty = hover
    ? uncertaintyComponents(
        hover.marker,
        getAge(hover.marker, hover.marker.receivedAt, viewTimeMs),
        tooltipRover,
      )
    : null;

  return h(
    "div",
    { className: "map-tools-and-canvas" },
    h(
      "div",
      { className: "map-toolbar", "aria-label": "Map controls" },
      h(
        "div",
        { className: "map-view-controls" },
        h(
          "button",
          { type: "button", className: "map-control-button", onClick: resetView },
          "Reset view",
        ),
        h(
          "button",
          {
            type: "button",
            className: `map-control-button${followRover ? " active" : ""}`,
            "aria-pressed": followRover,
            onClick: () => onToggleFollow(!followRover),
          },
          followRover ? "Following rover" : "Follow rover",
        ),
        h("span", { className: "zoom-readout" }, `${zoomDisplay.toFixed(1)}×`),
        h("span", { className: "zoom-readout" }, "K axes · D debug"),
      ),
      h(
        "div",
        { className: "map-view-controls" },
        h(
          "button",
          {
            type: "button",
            className: "map-control-button",
            onClick: onTogglePause,
          },
          paused ? "Resume live" : "Pause live",
        ),
        h(
          "label",
          { className: "map-check map-check-inline" },
          h("input", {
            type: "checkbox",
            checked: showUncertainty,
            onChange: onToggleUncertainty,
          }),
          "Uncertainty",
        ),
        h(
          "label",
          { className: "map-check map-check-inline" },
          h("input", {
            type: "checkbox",
            checked: showRoverPath,
            onChange: onToggleRoverPath,
          }),
          "Rover path",
        ),
      ),
      h(
        "div",
        { className: "map-time-controls" },
        h(
          "label",
          { className: "time-slider-label", htmlFor: "replay-time" },
          paused ? "REPLAY" : "LIVE",
        ),
        h("input", {
          id: "replay-time",
          className: "time-slider",
          type: "range",
          min: sliderMinMs,
          max: sliderMaxMs,
          step: 500,
          value: Math.max(
            sliderMinMs,
            Math.min(sliderMaxMs, viewTimeMs),
          ),
          onChange: (event) => {
            const nextTime = Number(event.target.value);
            propsRef.current.onSetReplayTime(nextTime);
          },
          "aria-label": "Replay detections from the last five minutes",
        }),
        h(
          "span",
          { className: "time-readout" },
          new Date(viewTimeMs).toLocaleTimeString(),
        ),
      ),
      h(
        "div",
        { className: "map-filter-controls", "aria-label": "Map filters" },
        h("span", { className: "filter-title" }, "CLASSES"),
        ...DETECTION_CLASSES.map(({ value, label }) =>
          h(
            "label",
            { className: "map-check", key: value },
            h("input", {
              type: "checkbox",
              checked: classFilters[value],
              onChange: () => onToggleClass(value),
            }),
            h("i", { className: `filter-swatch class-${value}` }),
            label,
          ),
        ),
        h(
          "label",
          { className: "map-check hide-expired-toggle" },
          h("input", {
            type: "checkbox",
            checked: hideExpired,
            onChange: onToggleHideExpired,
          }),
          "Hide expired",
        ),
      ),
    ),
    h(
      "div",
      { className: "map-canvas-wrap", ref: wrapperRef },
      displayBanner
        ? h(
            "div",
            {
              className: `simulation-banner simulation-map-banner${displayBanner.preview ? " preview" : ""}`,
              role: "status",
            },
            displayBanner.text,
            displayBanner.simulated
              ? h("span", { className: "simulation-tag" }, "SIM")
              : null,
          )
        : null,
      h("canvas", {
        ref: canvasRef,
        className: "map-canvas",
        "aria-label":
          "Interactive hazard map. Wheel to zoom, drag to pan, and click a marker for details.",
      }),
      h(
        "div",
        { className: "map-compass", "aria-label": "Map orientation" },
        h("strong", null, "N ↑"),
        h("span", null, "E →"),
      ),
      h(
        "div",
        { className: "map-scale", "aria-label": `Map scale ${(
          100 /
          SCALE /
          cameraRef.current.zoom /
          100
        ).toFixed(1)} meters` },
        h("span", null, `${(100 / SCALE / cameraRef.current.zoom / 100).toFixed(1)} m`),
        h("i", null),
      ),
      h("output", { className: "map-cursor-coordinates", "aria-live": "off" }, cursorCoordinates),
      hoveredIsVisible
        ? h(
            "div",
            {
              className: "map-tooltip",
              style: {
                left: `${Math.max(
                  8,
                  Math.min(
                    hover.x + 14,
                    (wrapperRef.current?.clientWidth ?? 520) - 235,
                  ),
                )}px`,
                top: `${Math.max(hover.y - 12, 12)}px`,
              },
              role: "status",
            },
            h(
              "strong",
              null,
              classLabel(hover.marker.class),
            ),
            h(
              "span",
              null,
              `E ${(hover.marker.x_cm / 100).toFixed(2)} m · N ${(hover.marker.y_cm / 100).toFixed(2)} m`,
            ),
            h("span", null, `Confidence ${hover.marker.conf}/7`),
            h(
              "span",
              null,
              `Uncertainty radius ±${(tooltipUncertainty.radiusCm / 100).toFixed(2)} m${tooltipUncertainty.estimated ? " · estimated" : ""}${tooltipUncertainty.estimated && !tooltipUncertainty.distanceAvailable ? " (rover range unavailable)" : ""}`,
            ),
            propsRef.current.simulationActive
              ? h("span", { className: "simulation-tag" }, "SIM")
              : null,
            h(
              "span",
              null,
              `Seen ${formatAge(getAge(hover.marker, hover.marker.receivedAt, viewTimeMs))}`,
            ),
            h("span", null, `ID ${hover.marker.id}`),
          )
        : null,
      signalLost
        ? h(
            "div",
            { className: "signal-lost-banner", role: "alert" },
            h("strong", null, "SIGNAL LOST"),
            h("span", { ref: bannerAgeRef }, "Last contact unknown"),
          )
        : null,
    ),
  );
});

export default MapCanvas;
