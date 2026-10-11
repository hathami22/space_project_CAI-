import {
  contactState,
  formatAge,
} from "../lib/telemetry.js";

const { useEffect, useRef, useState } = React;
const h = React.createElement;

const LINK_STATE_LABELS = {
  LINKED: "AOS",
  DEGRADED: "DEGRADED",
  BLACKOUT: "BLACKOUT",
  NO_CONTACT: "NO CONTACT",
  SERVER_DISCONNECTED: "SERVER OFFLINE",
};

const LINK_STATE_STYLES = {
  LINKED: "ok",
  DEGRADED: "degraded",
  BLACKOUT: "lost",
  NO_CONTACT: "unknown",
  SERVER_DISCONNECTED: "server-offline",
};

function LossSparkline({ history, linkState, theme }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return undefined;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(bounds.width * ratio);
      const height = Math.round(bounds.height * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      const palette = getComputedStyle(canvas);
      context.strokeStyle = palette.getPropertyValue("--grid").trim();
      context.lineWidth = 0.5;
      for (const level of [0, 0.5, 1]) {
        context.beginPath();
        context.moveTo(0, bounds.height * level);
        context.lineTo(bounds.width, bounds.height * level);
        context.stroke();
      }
      if (!history.length) return;

      const now = Date.now();
      const start = now - 60_000;
      const points = history.map((sample) => ({
        x: Math.max(
          0,
          Math.min(bounds.width, ((sample.time - start) / 60_000) * bounds.width),
        ),
        y: bounds.height - (sample.lossPct / 100) * bounds.height,
      }));
      const color =
        palette.getPropertyValue(
          linkState === "ok"
            ? "--nominal"
            : linkState === "degraded"
              ? "--warning"
              : linkState === "lost"
                ? "--alarm"
                : "--stale",
        ).trim();

      context.beginPath();
      context.moveTo(points[0].x, bounds.height);
      for (const point of points) context.lineTo(point.x, point.y);
      context.lineTo(points[points.length - 1].x, bounds.height);
      context.closePath();
      context.fillStyle = color;
      context.globalAlpha = 0.08;
      context.fill();
      context.globalAlpha = 1;

      context.beginPath();
      points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.stroke();
    };

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [history, linkState, theme]);

  return h("canvas", {
    ref: canvasRef,
    className: "loss-sparkline",
    role: "img",
    "aria-label": "Packet loss percentage over the last 60 seconds",
  });
}

export default function LinkStatus({
  link,
  linkHistory,
  lastSnapshotAgeMs,
  serverConnected,
  connectionState,
  sendBlackout,
  theme,
  blackoutPending = false,
}) {
  const [requestedBlackout, setRequestedBlackout] = useState(null);
  const [ackMessage, setAckMessage] = useState("");
  const acknowledgementTimerRef = useRef(null);
  const state = contactState({ serverConnected, lastSnapshotAgeMs, link });
  const visualState = LINK_STATE_STYLES[state];
  const received = link?.received ?? 0;
  const lost = link?.lost ?? 0;
  const lossPct = link?.loss_pct ?? 0;
  const lossSeverity =
    lossPct > 30 ? "alarm" : lossPct >= 10 ? "warning" : "nominal";
  const lastPacket = Number.isFinite(link?.since_last_rx_ms)
    ? formatAge(link.since_last_rx_ms)
    : "No contact yet";
  useEffect(() => {
    if (
      requestedBlackout !== null &&
      link?.blackout === requestedBlackout
    ) {
      window.clearTimeout(acknowledgementTimerRef.current);
      setRequestedBlackout(null);
      setAckMessage("");
    }
  }, [link?.blackout, requestedBlackout]);

  useEffect(
    () => () => window.clearTimeout(acknowledgementTimerRef.current),
    [],
  );

  const requestBlackout = () => {
    const on = link?.blackout !== true;
    if (!sendBlackout(on)) {
      setAckMessage("server did not acknowledge");
      return;
    }
    window.clearTimeout(acknowledgementTimerRef.current);
    setRequestedBlackout(on);
    setAckMessage("waiting for server...");
    acknowledgementTimerRef.current = window.setTimeout(() => {
      setRequestedBlackout(null);
      setAckMessage("server did not acknowledge");
    }, 3000);
  };

  return h(
    "section",
    {
      className: `panel link-panel link-${visualState} link-state-${visualState}`,
    },
    h(
      "div",
      { className: "panel-heading" },
      h(
        "div",
        null,
        h("h2", null, "LINK STATUS"),
      ),
      h(
        "span",
        { className: `radio-status link-state-${visualState}` },
        h("span", { className: "connection-dot" }),
        LINK_STATE_LABELS[state],
      ),
    ),
    h(
      "div",
      { className: "blackout-control" },
      h(
        "button",
        {
          type: "button",
          className: "map-control-button blackout-button",
          disabled:
            connectionState !== "connected" ||
            requestedBlackout !== null ||
            blackoutPending,
          title:
            connectionState !== "connected"
              ? "Disabled while the WebSocket is closed or the scenario player is active"
              : blackoutPending
                ? "A timed blackout request is already active"
              : link?.blackout === true
                ? "Sends set_blackout on:false to the server"
                : "Sends set_blackout on:true to the server",
          onClick: requestBlackout,
        },
        link?.blackout === true
          ? "RESTORE LINK · SENDS TO SERVER"
          : "KILL THE LINK · SENDS TO SERVER",
      ),
      ackMessage
        ? h(
            "span",
            {
              className: `blackout-ack${
                ackMessage === "server did not acknowledge" ? " failed" : ""
              }`,
              role: "status",
            },
            ackMessage,
          )
        : null,
    ),
    h("p", { className: "server-message-note" },
      "Explicit server command: set_blackout only.",
    ),
    h(
      "div",
      { className: "link-stats" },
      h(
        "div",
        { className: "stat" },
        h("span", null, "RECEIVED"),
        h("strong", null, `${received.toLocaleString()} pkts`),
      ),
      h(
        "div",
        { className: "stat" },
        h("span", null, "LOST"),
        h("strong", { className: lost ? "warning-value" : "" }, `${lost.toLocaleString()} pkts`),
      ),
      h(
        "div",
        { className: `stat loss-stat ${lossSeverity}` },
        h("span", null, "CURRENT PACKET LOSS"),
        h(
          "strong",
          null,
          lossPct.toFixed(1),
          h("small", null, "%"),
        ),
      ),
      h(
        "div",
        { className: "stat" },
        h("span", null, "LAST PACKET"),
        h("strong", { className: "age-value" }, lastPacket),
      ),
      h(
        "div",
        { className: "stat" },
        h("span", null, "CRC FAIL"),
        h("strong", null, `${(link?.crc_fail ?? 0).toLocaleString()} pkts`),
      ),
      h(
        "div",
        { className: "stat" },
        h("span", null, "DUPLICATES"),
        h("strong", null, `${(link?.duplicates ?? 0).toLocaleString()} pkts`),
      ),
      h(
        "div",
        { className: "stat" },
        h("span", null, "REORDERED"),
        h("strong", null, `${(link?.reordered ?? 0).toLocaleString()} pkts`),
      ),
      h(
        "div",
        { className: "stat" },
        h("span", null, "BYTES RX"),
        h("strong", null, `${(link?.bytes_rx ?? 0).toLocaleString()} B`),
      ),
    ),
    h(
      "div",
      { className: "sparkline-heading" },
      h("span", null, "LOSS · LAST 60 S"),
      h("span", null, `${lossPct.toFixed(1)}% now`),
    ),
    h(
      "div",
      { className: "sparkline-chart" },
      h("span", { className: "spark-axis axis-100" }, "100%"),
      h("span", { className: "spark-axis axis-50" }, "50%"),
      h("span", { className: "spark-axis axis-0" }, "0%"),
      h(LossSparkline, { history: linkHistory, linkState: visualState, theme }),
    ),
    h(
      "div",
      {
        className: "link-meter",
        "aria-label": `${lossPct.toFixed(1)} percent packet loss`,
      },
      h("span", {
        style: { width: `${Math.min(100, Math.max(0, lossPct))}%` },
      }),
    ),
  );
}
