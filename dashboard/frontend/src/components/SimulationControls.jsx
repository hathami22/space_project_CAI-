import { TIME_WARP_MAX_SECONDS } from "../lib/simulation.js";

const h = React.createElement;

const SPEEDS = [1, 2, 4];

export default function SimulationControls({
  active,
  playing,
  speed,
  elapsedMs,
  warpSeconds,
  scenario,
  serverConnected,
  blackoutRemainingSeconds,
  blackoutConfirmed,
  blackoutInProgress,
  message,
  onStart,
  onPause,
  onRestart,
  onStop,
  onSpeedChange,
  onWarpChange,
  onResetWarp,
  onScenarioChange,
  onLongBlackout,
}) {
  return h(
    "div",
    { className: "sidebar-section-content simulation-content" },
    h("p", { className: "simulation-safety-note" },
      "Display-only data stays separate from live telemetry. Only the labeled blackout control sends a server message.",
    ),
    h("h3", null, "TIME WARP"),
    h(
      "label",
      { className: "simulation-range-label", htmlFor: "time-warp" },
      h("span", null, "Display age offset"),
      h("strong", null, `+${warpSeconds} s`),
    ),
    h("input", {
      id: "time-warp",
      className: "simulation-range",
      type: "range",
      min: 0,
      max: TIME_WARP_MAX_SECONDS,
      step: 1,
      value: warpSeconds,
      onChange: (event) => onWarpChange(Number(event.target.value)),
      "aria-label": "Display-only time warp in seconds",
    }),
    h(
      "button",
      { className: "simulation-button", type: "button", onClick: onResetWarp },
      "Reset time warp",
    ),
    h("h3", null, "LINK SCENARIOS"),
    h(
      "div",
      { className: "simulation-button-group" },
      h(
        "button",
        {
          className: `simulation-button${scenario === "clear" ? " active" : ""}`,
          type: "button",
          "aria-pressed": scenario === "clear",
          onClick: () => onScenarioChange("clear"),
        },
        "Clear link",
      ),
      h(
        "button",
        {
          className: `simulation-button${scenario === "noisy" ? " active" : ""}`,
          type: "button",
          "aria-pressed": scenario === "noisy",
          onClick: () => onScenarioChange("noisy"),
        },
        "Noisy link · 30%",
      ),
      h(
        "button",
        {
          className: `simulation-button${scenario === "live" ? " active" : ""}`,
          type: "button",
          "aria-pressed": scenario === "live",
          onClick: () => onScenarioChange("live"),
        },
        "Live telemetry",
      ),
    ),
    scenario === "noisy"
      ? h("p", { className: "simulation-preview-label" }, "PREVIEW ONLY · roughly 30% of incoming snapshots hidden from this display")
      : scenario === "clear"
        ? h("p", { className: "simulation-preview-label" }, "PREVIEW ONLY · display shows 0% loss; live telemetry is not modified")
        : h("p", { className: "simulation-preview-label" }, "LIVE TELEMETRY · no link preview"),
    h(
      "button",
      {
        className: "simulation-button server-action-button",
        type: "button",
        disabled: !serverConnected || active || blackoutInProgress,
        title: active
          ? "Stop the scenario player before requesting a live server blackout"
          : !serverConnected
            ? "Disabled while the WebSocket is closed"
            : blackoutInProgress
              ? "A 60-second blackout request is already active"
            : "Sends set_blackout to the server",
        onClick: onLongBlackout,
      },
      "Long blackout (60 s) — sends to server",
    ),
    Number.isFinite(blackoutRemainingSeconds)
      ? h(
          "p",
          { className: "simulation-blackout-status", role: "status" },
          `Blackout ${blackoutConfirmed ? "confirmed" : "awaiting confirmation"} · ${blackoutRemainingSeconds} s remaining`,
        )
      : null,
    message ? h("p", { className: "simulation-message", role: "status" }, message) : null,
    h("h3", null, "SCENARIO PLAYER"),
    active
      ? h(
          React.Fragment,
          null,
          h("p", { className: "simulation-player-clock" },
            `SIM T+${String(Math.floor(elapsedMs / 3600000)).padStart(2, "0")}:${String(Math.floor(elapsedMs / 60000) % 60).padStart(2, "0")}:${String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0")}`,
          ),
          h(
            "div",
            { className: "simulation-button-group" },
            h(
              "button",
              { className: "simulation-button", type: "button", onClick: playing ? onPause : onStart },
              playing ? "Pause" : "Play",
            ),
            h(
              "button",
              { className: "simulation-button", type: "button", onClick: onRestart },
              "Restart",
            ),
            h(
              "button",
              { className: "simulation-button", type: "button", onClick: onStop },
              "Stop simulation",
            ),
          ),
          h(
            "div",
            { className: "simulation-speed-controls", role: "group", "aria-label": "Scenario speed" },
            h("span", null, "SPEED"),
            ...SPEEDS.map((value) =>
              h(
                "button",
                {
                  key: value,
                  type: "button",
                  className: `simulation-speed${speed === value ? " active" : ""}`,
                  "aria-pressed": speed === value,
                  onClick: () => onSpeedChange(value),
                },
                `${value}×`,
              ),
            ),
          ),
        )
      : h(
          "button",
          { className: "simulation-button simulation-start", type: "button", onClick: onStart },
          "Play offline scenario",
        ),
  );
}
