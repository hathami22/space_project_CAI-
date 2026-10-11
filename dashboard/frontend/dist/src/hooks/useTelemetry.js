import {
  eventTimeMs,
  getAge,
  parseMessage,
  TELEMETRY_CONFIG,
} from "../lib/telemetry.js";
import { DASHBOARD_CONFIG } from "../config.js";

const { useEffect, useRef, useState } = React;
const RECONNECT_DELAY_MS = DASHBOARD_CONFIG.telemetry.reconnectDelayMs;
const REFRESH_INTERVAL_MS = DASHBOARD_CONFIG.telemetry.refreshIntervalMs;
const RETENTION_WINDOW_MS = TELEMETRY_CONFIG.ageMs.remove;
const DIAGNOSTIC_WINDOW_MS = DASHBOARD_CONFIG.telemetry.diagnosticWindowMs;
const MAX_RECORDED_VIOLATIONS =
  DASHBOARD_CONFIG.telemetry.maxRecordedViolations;

function recordViolations(diagnostics, violations) {
  if (!violations.length) return;
  diagnostics.contractIssueCount += violations.length;
  diagnostics.violations = [
    ...diagnostics.violations,
    ...violations.map((message) => ({ time: Date.now(), message })),
  ].slice(-MAX_RECORDED_VIOLATIONS);
}

function webSocketState(socket) {
  if (!socket) return "CLOSED";
  return ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][socket.readyState] ?? "UNKNOWN";
}

export function useTelemetry() {
  const snapshotRef = useRef(null);
  const hazardsRef = useRef([]);
  const roverPathRef = useRef([]);
  const roverSampleKeysRef = useRef(new Set());
  const linkHistoryRef = useRef([]);
  const socketRef = useRef(null);
  const diagnosticsRef = useRef({
    lastRawMessage: "",
    snapshots: [],
    totalBytes: 0,
    snapshotCount: 0,
    contractIssueCount: 0,
    violations: [],
  });
  const [clockNow, setClockNow] = useState(Date.now());
  const [connectionState, setConnectionState] = useState("connecting");

  useEffect(() => {
    let reconnectTimer;
    let stopped = false;
    let reconnecting = false;

    const connect = () => {
      if (stopped) return;
      setConnectionState(reconnecting ? "reconnecting" : "connecting");
      const socket = new WebSocket(TELEMETRY_CONFIG.webSocketUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        reconnecting = false;
        setConnectionState("connected");
      };

      socket.onmessage = (event) => {
        const rawText =
          typeof event.data === "string" ? event.data : String(event.data);
        const diagnostics = diagnosticsRef.current;
        diagnostics.lastRawMessage = rawText;

        const result = parseMessage(event.data);
        recordViolations(diagnostics, result.violations ?? []);
        if (!result.ok) {
          console.error("Ignoring invalid telemetry snapshot:", result.error);
          return;
        }

        const receivedAt = Date.now();
        diagnostics.totalBytes += new TextEncoder().encode(rawText).length;
        diagnostics.snapshotCount += 1;
        diagnostics.snapshots = [
          ...diagnostics.snapshots.filter(
            (time) => time >= receivedAt - DIAGNOSTIC_WINDOW_MS,
          ),
          receivedAt,
        ];

        const nextHazards = new Map(
          hazardsRef.current.map((hazard) => [hazard.id, hazard]),
        );
        for (const hazard of result.snapshot.hazards) {
          nextHazards.set(hazard.id, {
            ...hazard,
            receivedAt,
            eventTimeMs: eventTimeMs(hazard, receivedAt),
          });
        }
        hazardsRef.current = [...nextHazards.values()].filter(
          (hazard) =>
            getAge(hazard, hazard.receivedAt, receivedAt) <= RETENTION_WINDOW_MS,
        );

        for (const sample of result.snapshot.roverSamples) {
          const identityValue =
            sample.ts_ms ??
            sample.first_rx_ms ??
            `${sample.x_cm}:${sample.y_cm}`;
          const identity = `${sample.id}:${identityValue}`;
          if (roverSampleKeysRef.current.has(identity)) continue;
          roverSampleKeysRef.current.add(identity);
          roverPathRef.current = [
            ...roverPathRef.current,
            {
              ...sample,
              receivedAt,
              eventTimeMs: eventTimeMs(sample, receivedAt),
              identity,
            },
          ];
        }

        snapshotRef.current = {
          ...result.snapshot,
          receivedAt,
        };
        linkHistoryRef.current = [
          ...linkHistoryRef.current.filter(
            (sample) =>
              sample.time >=
              receivedAt - TELEMETRY_CONFIG.historyWindowMs,
          ),
          {
            time: receivedAt,
            lossPct: result.snapshot.link.loss_pct,
            expected: result.snapshot.link.expected,
            received: result.snapshot.link.received,
            bytesRx: result.snapshot.link.bytes_rx,
          },
        ];
      };

      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (stopped) return;
        reconnecting = true;
        setConnectionState("reconnecting");
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClockNow(now);

      hazardsRef.current = hazardsRef.current.filter(
        (hazard) =>
          getAge(hazard, hazard.receivedAt, now) <= RETENTION_WINDOW_MS,
      );
      roverPathRef.current = roverPathRef.current.filter(
        (point) => now - point.receivedAt <= RETENTION_WINDOW_MS,
      );
      roverSampleKeysRef.current = new Set(
        roverPathRef.current.map((point) => point.identity),
      );

      const cutoff = now - TELEMETRY_CONFIG.historyWindowMs;
      linkHistoryRef.current = linkHistoryRef.current.filter(
        (sample) => sample.time >= cutoff,
      );
      diagnosticsRef.current.snapshots =
        diagnosticsRef.current.snapshots.filter(
          (time) => time >= now - DIAGNOSTIC_WINDOW_MS,
        );
    }, REFRESH_INTERVAL_MS);

    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const snapshot = snapshotRef.current;
  const linkReceivedAt = snapshot?.receivedAt ?? null;
  const link =
    snapshot?.link && linkReceivedAt !== null
      ? {
          ...snapshot.link,
          since_last_rx_ms: Number.isFinite(snapshot.link.since_last_rx_ms)
            ? getAge(
                { age_ms: snapshot.link.since_last_rx_ms },
                linkReceivedAt,
                clockNow,
              )
            : undefined,
        }
      : null;
  const lastSnapshotAgeMs =
    linkReceivedAt === null ? null : Math.max(0, clockNow - linkReceivedAt);
  const diagnostics = diagnosticsRef.current;
  const snapshotRateHz =
    diagnostics.snapshots.length > 1
      ? (diagnostics.snapshots.length - 1) *
        1000 /
        (diagnostics.snapshots.at(-1) - diagnostics.snapshots[0])
      : 0;

  const sendBlackout = (on) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(
      JSON.stringify({
        type: TELEMETRY_CONFIG.clientMessageTypes.setBlackout,
        on,
      }),
    );
    return true;
  };

  return {
    snapshotRef,
    hazardsRef,
    roverPathRef,
    link,
    linkHistory: linkHistoryRef.current,
    lastSnapshotAgeMs,
    clockNow,
    connectionState,
    sendBlackout,
    rawMessage: diagnostics.lastRawMessage,
    snapshotRateHz,
    averageSnapshotBytes:
      diagnostics.snapshotCount > 0
        ? diagnostics.totalBytes / diagnostics.snapshotCount
        : 0,
    contractIssueCount: diagnostics.contractIssueCount,
    violations: diagnostics.violations,
    webSocketState: webSocketState(socketRef.current),
  };
}
