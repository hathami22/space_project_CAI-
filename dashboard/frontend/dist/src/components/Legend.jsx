import { DETECTION_CLASSES } from "../lib/telemetry.js";

const h = React.createElement;

export default function Legend() {
  return h(
    "section",
    { className: "panel legend-panel" },
    h(
      "div",
      { className: "panel-heading" },
      h(
        "div",
        null,
        h("p", { className: "eyebrow" }, "Detection classes"),
        h("h2", null, "Map legend"),
      ),
    ),
    h(
      "ul",
      { className: "legend-list" },
      ...DETECTION_CLASSES.map((item) =>
        h(
          "li",
          { key: item.value },
          h("span", { className: `class-swatch class-${item.value}` }),
          h("span", null, item.label),
          h("span", { className: "legend-id" }, item.value.toUpperCase()),
        ),
      ),
      h(
        "li",
        null,
        h("span", { className: "rover-swatch" }),
        h("span", null, "Rover + path"),
        h("span", { className: "legend-id" }, "POS"),
      ),
      ...[
        ["fresh", "FRESH"],
        ["aging", "AGING"],
        ["stale", "STALE"],
        ["expired", "EXPIRED"],
      ].map(([stage, label]) =>
        h(
          "li",
          { key: stage },
          h("span", { className: `freshness-swatch freshness-${stage}` }),
          h("span", null, label),
        ),
      ),
      h(
        "li",
        { key: "uncertainty" },
        h("span", { className: "uncertainty-swatch" }),
        h("span", null, "Uncertainty radius"),
      ),
    ),
  );
}
