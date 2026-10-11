import { SCENARIO_CHECKLIST } from "../config.js";
import {
  calculateBytesPerSecond,
  checklistProgress,
  filterEvents,
  trustVerdict,
  uncertaintyBreakdown,
} from "../lib/sidebar.js";
import { ageStage, getAge } from "../lib/telemetry.js";
import SimulationControls from "./SimulationControls.jsx";

const { useEffect, useRef, useState } = React;
const h = React.createElement;
const CHECKLIST_STORAGE_KEY = "crater-scenario-checklist";
const SIDEBAR_WIDTH_QUERY = "(min-width: 1100px)";

function readChecklist() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CHECKLIST_STORAGE_KEY));
    if (Array.isArray(saved)) {
      return SCENARIO_CHECKLIST.map((_, index) => saved[index] === true);
    }
  } catch {
    return SCENARIO_CHECKLIST.map(() => false);
  }
  return SCENARIO_CHECKLIST.map(() => false);
}

function formatMissionTime(timeMs) {
  const seconds = Math.max(0, Math.floor((timeMs ?? 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `T+${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(remainder).padStart(2, "0")}`;
}

function formatMeters(cm) {
  return Number.isFinite(cm) ? `${(cm / 100).toFixed(2)} m` : "—";
}

function formatValue(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function directionBearing(xCm, yCm) {
  if (!Number.isFinite(xCm) || !Number.isFinite(yCm)) return "—";
  const degrees = (Math.atan2(xCm, yCm) * 180) / Math.PI;
  return `${((degrees + 360) % 360).toFixed(0)}°`;
}

function ConfidenceMeter({ confidence }) {
  const value = Number.isInteger(confidence)
    ? Math.max(0, Math.min(7, confidence))
    : 0;
  const label = !Number.isInteger(confidence)
    ? "—"
    : value <= 2
      ? "LOW"
      : value <= 4
        ? "MEDIUM"
        : "HIGH";
  return h(
    "div",
    { className: "explain-confidence" },
    h(
      "div",
      { className: "left-sidebar-value-row" },
      h("span", null, `CONFIDENCE · ${label}`),
      h("strong", null, Number.isInteger(confidence) ? `${value}/7` : "—"),
    ),
    h(
      "div",
      {
        className: "confidence-meter",
        role: "meter",
        "aria-label": "Detection confidence",
        "aria-valuemin": 0,
        "aria-valuemax": 7,
        "aria-valuenow": value,
      },
      ...Array.from({ length: 7 }, (_, index) =>
        h("i", {
          key: index,
          className: index < value ? "filled" : "",
          "aria-hidden": "true",
        }),
      ),
    ),
  );
}

function ExplainSection({ hazard, viewTimeMs, roverPosition }) {
  const ageMs = hazard
    ? getAge(hazard, hazard.receivedAt, viewTimeMs)
    : null;
  const breakdown = hazard
    ? uncertaintyBreakdown(hazard, ageMs, roverPosition)
    : null;
  const trust = hazard ? trustVerdict(ageMs, hazard.conf) : null;
  const stage = hazard ? ageStage(ageMs) : null;
  const notes = hazard
    ? ["reason", "alt_class", "alt_conf"].filter(
        (field) => hazard[field] !== undefined && hazard[field] !== null,
      )
    : [];
  const ageShare = breakdown
    ? breakdown.radiusCm > 0
      ? Math.min(
          Math.max(0, 100 - (Math.min(
          breakdown.geometryCm,
            breakdown.radiusCm,
          ) / breakdown.radiusCm) * 100),
          (breakdown.ageCm / breakdown.radiusCm) * 100,
        )
      : 0
    : 0;
  const geometryShare = breakdown
    ? breakdown.radiusCm > 0
      ? Math.min(100, (breakdown.geometryCm / breakdown.radiusCm) * 100)
      : 0
    : 0;
  return h(
    "div",
    { className: "sidebar-section-content explain-content" },
    hazard
      ? h(
          React.Fragment,
          null,
          h(
            "div",
            { className: "explain-class-row" },
            h("span", null, "CLASS"),
            h("strong", null, String(hazard.class).toUpperCase()),
          ),
          h(ConfidenceMeter, { confidence: hazard.conf }),
          h(
            "div",
            { className: `trust-verdict trust-${trust.verdict === "RELIABLE" ? "reliable" : trust.verdict === "VERIFY" ? "verify" : "reject"}` },
            h("span", null, "TRUST VERDICT"),
            h("strong", null, trust.verdict),
            h("small", null, `Rule: ${trust.rule}`),
            h("small", null, `Age stage: ${stage}`),
          ),
          h(
            "div",
            { className: "uncertainty-breakdown" },
            h(
              "div",
              { className: "left-sidebar-value-row" },
              h("span", null, "UNCERTAINTY RADIUS"),
              h(
                "strong",
                null,
                breakdown.capped
                  ? "3.00 m (cap)"
                  : formatMeters(breakdown.radiusCm),
              ),
            ),
            h(
              "div",
              {
                className: "uncertainty-stack",
                role: "img",
                "aria-label": "Geometry and age contributions to uncertainty radius",
              },
              h("span", {
                className: "uncertainty-geometry",
                style: { width: `${geometryShare}%` },
              }),
              h("span", {
                className: "uncertainty-age",
                style: { width: `${ageShare}%` },
              }),
            ),
            h(
              "div",
              { className: "uncertainty-legend" },
              h(
                "span",
                null,
                `Geometry · ${formatMeters(breakdown.geometryCm)}${breakdown.estimated ? ` estimated${breakdown.distanceAvailable ? "" : " · rover range unavailable"}` : ""}`,
              ),
              h("span", null, `Age · ${formatMeters(breakdown.ageCm)}`),
            ),
            breakdown.capped
              ? h("p", { className: "sidebar-note" }, "The 300 cm radius cap applies.")
              : null,
            h(
              "p",
              { className: "uncertainty-explanation" },
              `Uncertainty radius is ${formatMeters(breakdown.radiusCm)} (${formatMeters(
                breakdown.radiusCm * 2,
              )} across): ${
                breakdown.estimated
                  ? `${formatMeters(breakdown.geometryCm)} estimated geometry error${
                      breakdown.distanceAvailable
                        ? " based on rover distance"
                        : "; rover range is unavailable"
                    }`
                  : `${formatMeters(breakdown.sigmaCm)} from distance`
              } and ${formatMeters(breakdown.ageCm)} because the data is ${Math.floor(
                breakdown.ageSeconds,
              )} s old.`,
            ),
          ),
          h(
            "dl",
            { className: "detection-position" },
            h("dt", null, "POSITION"),
            h(
              "dd",
              null,
              `X ${formatMeters(hazard.x_cm)} · Y ${formatMeters(hazard.y_cm)}`,
            ),
            h("dt", null, "DISTANCE / BEARING"),
            h(
              "dd",
              null,
              `${formatMeters(Math.hypot(hazard.x_cm, hazard.y_cm))} · ${directionBearing(hazard.x_cm, hazard.y_cm)} from landing site`,
            ),
            h("dt", null, "FIRST RECEIVED"),
            h(
              "dd",
              null,
              Number.isFinite(hazard.first_rx_ms)
                ? formatMissionTime(hazard.first_rx_ms)
                : "— (not supplied)",
            ),
          ),
          notes.length
            ? h(
                "div",
                { className: "detector-notes" },
                h("h4", null, "DETECTOR NOTES"),
                ...notes.map((field) =>
                  h(
                    "p",
                    { key: field },
                    h("span", null, `${field.replace("_", " ")} · `),
                    String(hazard[field]),
                  ),
                ),
              )
            : null,
        )
      : h("p", { className: "sidebar-empty" }, "Select a hazard on the map"),
  );
}

function EventLogSection({ events }) {
  const [filter, setFilter] = useState("all");
  const visible = filterEvents(events, filter);
  return h(
    "div",
    { className: "sidebar-section-content" },
    h(
      "label",
      { className: "event-filter" },
      h("span", null, "FILTER"),
      h(
        "select",
        {
          value: filter,
          onChange: (event) => setFilter(event.target.value),
          "aria-label": "Filter mission events",
        },
        ...[
          ["all", "All events"],
          ["exclude-sim", "Hide SIM"],
          ["link", "Link"],
          ["hazard", "Hazards"],
          ["server", "Server"],
          ["mission", "Mission"],
        ].map(([value, label]) =>
          h("option", { key: value, value }, label),
        ),
      ),
    ),
    visible.length
      ? h(
          "ol",
          { className: "sidebar-event-list" },
          ...visible.map((item) =>
            h(
              "li",
              {
                className: `event-${item.kind}${item.simulated ? " simulated-event" : ""}`,
                key: item.id,
              },
              h("time", null, formatMissionTime(item.tMs)),
              h("strong", null, item.code),
              item.simulated ? h("em", null, "SIM") : null,
              h("span", null, item.message),
            ),
          ),
        )
      : h("p", { className: "sidebar-empty" }, "No events match this filter"),
  );
}

function metricValue(metrics, key, fallback, digits, unit) {
  const measured = metrics?.[key];
  if (Number.isFinite(measured)) {
    return `${formatValue(measured, digits)} ${unit} · measured`;
  }
  return Number.isFinite(fallback)
    ? `${formatValue(fallback, digits)} ${unit} · estimated`
    : "—";
}

function BandwidthSection({
  link,
  bytesPerSecond,
  snapshot,
  fileMetrics,
  hazardCount,
}) {
  const measured = { ...fileMetrics, ...snapshot?.measuredMetrics };
  const estimatedHazardCount = hazardCount > 0 ? hazardCount : null;
  const bytesRx = link?.bytes_rx;
  const received = link?.received;
  const avgBytes =
    Number.isFinite(bytesRx) && Number.isFinite(received) && received > 0
      ? bytesRx / received
      : null;
  const jsonBytes =
    Number.isFinite(measured.json_bytes)
      ? measured.json_bytes
      : snapshot?.estimatedJsonBytes;
  const compression =
    Number.isFinite(measured.compression_ratio)
      ? measured.compression_ratio
      : Number.isFinite(jsonBytes) && Number.isFinite(avgBytes) && avgBytes > 0
        ? jsonBytes / avgBytes
        : null;
  const counters = [
    ["CRC FAIL", link?.crc_fail],
    ["DUPLICATES", link?.duplicates],
    ["REORDERED", link?.reordered],
    [
      "HAZARDS EXPECTED",
      measured.hazards_expected ?? estimatedHazardCount,
      Number.isFinite(measured.hazards_expected) ? "measured" : "estimated",
    ],
    [
      "HAZARDS DELIVERED",
      measured.hazards_delivered ?? estimatedHazardCount,
      Number.isFinite(measured.hazards_delivered) ? "measured" : "estimated",
    ],
  ];
  return h(
    "div",
    { className: "sidebar-section-content" },
    h(
      "dl",
      { className: "bandwidth-metrics" },
      h("dt", null, "RECEIVE RATE"),
      h(
        "dd",
        null,
        metricValue(measured, "bytes_per_second", bytesPerSecond, 1, "B/s"),
      ),
      h("dt", null, "AVERAGE / PACKET"),
      h(
        "dd",
        null,
        metricValue(measured, "average_packet_bytes", avgBytes, 1, "B"),
      ),
      h("dt", null, "JSON TEXT SIZE"),
      h("dd", null, metricValue(measured, "json_bytes", jsonBytes, 0, "B")),
      h("dt", null, "COMPRESSION RATIO"),
      h(
        "dd",
        null,
        Number.isFinite(compression)
          ? `${formatValue(compression, 2)}:1 · ${Number.isFinite(measured.compression_ratio) ? "measured" : "estimated"}`
          : "—",
      ),
    ),
    h(
      "div",
      { className: "bandwidth-counters" },
      ...counters.map(([label, value, source]) =>
        h(
          "div",
          { key: label },
          h("span", null, label),
          h(
            "strong",
            null,
            Number.isFinite(value)
              ? `${value.toLocaleString()}${source ? ` · ${source}` : ""}`
              : "—",
          ),
        ),
      ),
    ),
  );
}

function ChecklistSection() {
  const [checked, setChecked] = useState(readChecklist);
  useEffect(() => {
    try {
      window.localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(checked));
    } catch {
      // Checklist progress remains active for this page.
    }
  }, [checked]);
  const progress = checklistProgress(SCENARIO_CHECKLIST, checked);
  return h(
    "div",
    { className: "sidebar-section-content checklist-content" },
    h(
      "div",
      { className: "left-sidebar-value-row" },
      h("span", null, "DEMO PROGRESS"),
      h("strong", null, `${progress}%`),
    ),
    h(
      "ol",
      null,
      ...SCENARIO_CHECKLIST.map((step, index) =>
        h(
          "li",
          { key: step },
          h("label", null,
            h("input", {
              type: "checkbox",
              checked: checked[index],
              onChange: (event) =>
                setChecked((current) =>
                  current.map((value, itemIndex) =>
                    itemIndex === index ? event.target.checked : value,
                  ),
                ),
            }),
            h("span", null, `${index + 1}. ${step}`),
          ),
        ),
      ),
    ),
    h(
      "button",
      {
        className: "checklist-reset",
        type: "button",
        onClick: () => setChecked(SCENARIO_CHECKLIST.map(() => false)),
      },
      "Reset checklist",
    ),
  );
}

export default function LeftSidebar({
  hazard,
  viewTimeMs,
  roverPosition,
  events,
  link,
  bytesPerSecond,
  snapshot,
  fileMetrics,
  hazardCount,
  simulation,
  simulationActions,
  open,
  onToggle,
}) {
  const panelRef = useRef(null);
  const jumpToSection = (id) => {
    const section = panelRef.current?.querySelector(`#sidebar-${id}`);
    if (!section) return;
    section.open = true;
    section.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const sections = [
    ["explain", "EXPLAIN THIS DETECTION", true, h(ExplainSection, { hazard, viewTimeMs, roverPosition })],
    ["events", "EVENT LOG", true, h(EventLogSection, { events })],
    ["bandwidth", "BANDWIDTH BUDGET", false, h(BandwidthSection, { link, bytesPerSecond, snapshot, fileMetrics, hazardCount })],
    ["checklist", "SCENARIO CHECKLIST", false, h(ChecklistSection)],
    [
      "simulation",
      "SIMULATION",
      false,
      h(SimulationControls, {
        ...simulation,
        ...simulationActions,
      }),
    ],
  ];

  return h(
    "aside",
    {
      className: `left-sidebar${open ? " is-open" : " is-collapsed"}`,
      "aria-label": "Mission tools",
    },
    h(
      "div",
      { className: "left-sidebar-header" },
      open ? h("span", null, "MISSION TOOLS") : null,
      h(
        "button",
        {
          type: "button",
          className: "left-sidebar-toggle",
          onClick: onToggle,
          "aria-label": open ? "Collapse sidebar" : "Expand sidebar",
          "aria-expanded": open,
          title: "Toggle sidebar (B)",
          "aria-keyshortcuts": "B",
        },
        open ? "‹" : "›",
      ),
    ),
    open
      ? h(
          "div",
          { className: "left-sidebar-sections", ref: panelRef },
          h(
            "nav",
            { className: "sidebar-quick-nav", "aria-label": "Quick navigation" },
            ...[
              ["explain", "Detection", "◎"],
              ["events", "Events", "⌁"],
              ["bandwidth", "Link", "↗"],
              ["checklist", "Checklist", "✓"],
              ["simulation", "Sim", "▶"],
            ].map(([id, label, icon]) =>
              h(
                "button",
                {
                  key: id,
                  type: "button",
                  className: "sidebar-nav-button",
                  onClick: () => jumpToSection(id),
                  title: `Open ${label}`,
                },
                h("span", { "aria-hidden": "true" }, icon),
                h("small", null, label),
              ),
            ),
          ),
          ...sections.map(([id, title, initiallyOpen, content]) =>
            h(
              "details",
              { className: "left-sidebar-section", id: `sidebar-${id}`, key: id, open: initiallyOpen },
              h("summary", null, title),
              content,
            ),
          ),
        )
      : h(
          "div",
          { className: "left-sidebar-collapsed-label", "aria-hidden": "true" },
          "TOOLS",
        ),
  );
}
