# C.R.A.T.E.R. Mission Control

Offline-first React dashboard for a lunar rover scout operating without GPS or
cloud connectivity. The canvas map supports zoom, pan, rover following, hazard
selection, class filters, uncertainty circles, and five-minute replay.

## Project structure

```text
dashboard/
  README.md
  requirements.txt
  mock_ws.py
  server.py
  tests/
    sidebar.test.mjs
    simulation.test.mjs
    wall-display.test.mjs
  frontend/
    .npmrc
    index.html
    package.json
    package-lock.json
    build_frontend.py
    dist/
      index.html
      vendor/
        react.production.min.js
        react-dom.production.min.js
      tests/
        output/
          telemetry_metrics.json
      src/
        App.jsx
        main.jsx
        styles.css
        sidebar.css
        simulation.css
        config.js
        telemetry_metrics.json
        components/
          AccessibilityPanel.jsx
          LeftSidebar.jsx
          Legend.jsx
          LinkStatus.jsx
          MapCanvas.jsx
          SimulationControls.jsx
          WallDisplay.jsx
        hooks/
          useTelemetry.js
        lib/
          sidebar.js
          simulation.js
          telemetry.js
          wallDisplay.js
    src/
      App.jsx
      main.jsx
      styles.css
      sidebar.css
      simulation.css
      wall-display.css
      config.js
      components/
        AccessibilityPanel.jsx
        LeftSidebar.jsx
        Legend.jsx
        LinkStatus.jsx
        MapCanvas.jsx
        SimulationControls.jsx
      hooks/
        useTelemetry.js
      lib/
        sidebar.js
        simulation.js
        telemetry.js
        wallDisplay.js
```

## Wall display

Press **W** or choose **Wall display** in the operator header to open a
projection-oriented HUD; **W** or **Back to operator view** returns to the
operator console. It uses a centered 1920 × 1080 design canvas scaled to the
window and shows a one-time **F11** fullscreen hint. The operator view remains
the default, and the same telemetry, selected hazard, pause state, and replay
position are retained while changing views.

The current HUD phase shows four gauges for delivery rate (the snapshot's
received/expected counters), packet loss derived from expected/received counter
deltas in the last 10 seconds, the share of displayed hazards in FRESH stage,
and link quality. Link quality is clamped to 0–100 and uses
`100 − windowed_loss_percent − (2 × last_packet_age_seconds)`; hover the gauge
for its formula. Below are counts by hazard class and age stage. The
per-class table uses displayed hazards for count and average confidence,
supplied `sigma_cm`, oldest displayed age, and nearest distance from the latest
rover sample. Values that cannot be computed are shown as **no data**; they are
not replaced with zero.

The schematic shows the rover, a camera field-of-view cone, and 5 m, 10 m, and
20 m reference rings. Its orientation is illustrative only; the telemetry does
not provide rover heading or camera pose, and the rings are not measured
terrain. The callout follows the selected hazard, or the most recent visible
detection when none is selected. The class bars count currently displayed
detections. The hazard map draws the current hazards, uncertainty circles, and
rover path using the operator map's shared zoom and pan state. Click a marker
to select that hazard in both views. During LOS, the map dims and reports the
mission time at which data froze. Empty telemetry remains **no data**.

The last two wall-display panels—the five-minute telemetry chart and the
detections/uncertainty chart—are added in the next phase.

Simulation and preview data carry a permanent **SIMULATION - not rover data**
banner and a **SIM** tag. Wall display does not create synthetic telemetry or
placeholder chart values. When connecting to the bundled mock, add `?sim=1` to
the dashboard URL to identify its otherwise contract-identical snapshots as
simulated; this flag changes only the local display and sends no new message.

## Telemetry contract

The browser expects one snapshot per second from
`ws://<location.hostname>:8765`. The browser WebSocket URL can be overridden by
the `?ws=` URL parameter. This contract is provisional until integration step 5.
Coordinates are centimeters, with `+x` east and `+y` north.

`t_ms` is the rover mission clock, never the browser clock; the browser only adds
local elapsed time to `age_ms` when it computes age.

Server-to-browser snapshot:

```json
{
  "type": "snapshot",
  "t_ms": 123456,
  "hazards": [
    {
      "id": "crater:3:-2",
      "class": "ice",
      "conf": 6,
      "x_cm": 1240,
      "y_cm": -380,
      "sigma_cm": 25,
      "ts_ms": 123420,
      "age_ms": 36,
      "since_rx_ms": 36,
      "first_rx_ms": 123420
    },
    {
      "id": "rover:beacon",
      "class": "beacon",
      "conf": 7,
      "x_cm": 680,
      "y_cm": 140,
      "ts_ms": 123456,
      "age_ms": 0,
      "since_rx_ms": 0,
      "first_rx_ms": 123456
    }
  ],
  "link": {
    "expected": 100,
    "received": 80,
    "lost": 20,
    "loss_pct": 20,
    "crc_fail": 1,
    "duplicates": 0,
    "reordered": 2,
    "bytes_rx": 4096,
    "last_rx_ms": 123450,
    "since_last_rx_ms": 6,
    "blackout": false
  }
}
```

The required snapshot fields are `type` (`"snapshot"`), non-negative numeric
`t_ms`, the `hazards` array, and the `link` object. Each hazard requires `id`
(non-empty string or finite number), `class` (string), and finite numeric
`x_cm` and `y_cm`. `conf` is an integer from 0 to 7 and is required except for
`beacon` entries. Optional hazard fields are `sigma_cm`, `ts_ms`, `age_ms`,
`since_rx_ms`, and `first_rx_ms`; when supplied, they must be non-negative
numbers. A `beacon` entry supplies a rover-position sample and is not shown as a
hazard.

The required link fields are non-negative integer `expected`, `received`, and
`lost`, and numeric `loss_pct` from 0 to 100. Optional fields are non-negative
integer `crc_fail`, `duplicates`, `reordered`, and `bytes_rx`; non-negative
numeric `last_rx_ms` and `since_last_rx_ms`; and boolean `blackout`.

Browser-to-server blackout control:

```json
{"type": "set_blackout", "on": true}
```

Send `on: false` to restore the link. The client validates a snapshot's
top-level structure and link object; an invalid individual hazard is skipped
without discarding other hazards in that snapshot. Contract issues are counted
in the footer, and the D-key debug panel lists recent violations.

## Running

`mock_ws.py` is a standalone Python `websockets` server at
`ws://localhost:8765`. It emits the snapshot contract above once per second,
with mission time starting at 0. It gradually introduces ten crater, rock, ice,
and unknown detections with string IDs, plus a moving `beacon` position sample.
The mock's detector uncertainty grows with rover-to-hazard distance. Link
counters include varying packet loss and a 10-second blackout at the start of
each 60-second cycle. A four-second non-blackout packet gap every 30 seconds
also makes the `DEGRADED` state easy to observe. During a blackout, snapshots
continue with `link.blackout: true`, no new detection packets are received, and
`since_last_rx_ms` increases.

`server.py` is only a static HTTP server for the built `frontend/dist` directory.
It does not provide a WebSocket endpoint. The HTTP port defaults to `8000`; one
telemetry process provides the WebSocket endpoint on port `8765`.

Install dependencies and build the static frontend from the repository root:

```powershell
python -m pip install -r dashboard\requirements.txt
cd dashboard\frontend
npm.cmd install
npm.cmd run build
cd ..\..
```

Open two PowerShell terminals at the repository root. Start the snapshot mock
first:

```powershell
cd dashboard
python .\mock_ws.py --host localhost --port 8765
```

Then start the static server in the other terminal:

```powershell
cd dashboard
python .\server.py --host localhost --port 8000
```

Open `http://localhost:8000`. The default WebSocket URL is derived from the
page's `location.hostname` and uses port `8765`; to connect to a different
WebSocket endpoint, provide its URL in the `ws` query parameter, for example:
`http://localhost:8000/?ws=ws%3A%2F%2Frover-host%3A8765`.

## Live telemetry in the centimeter map frame

The merged telemetry bridge emits the same WebSocket snapshot contract consumed
by this dashboard. From the repository root, run either the telemetry demo
bridge or the perception replay bridge on port `8765`; do not run it at the
same time as `dashboard/mock_ws.py`.

The simulated bridge needs the dashboard's `websockets` dependency. The
perception replay additionally needs the repository-root requirements for
OpenCV, NumPy, and Ultralytics.

```powershell
# Simulated rover positions and detections
python -m telemetry.bridge --loss 0.1

# Or run the detector over a video/image sequence
python run_live.py --frames <video-or-image-folder> --weights best.pt --speed 30 --fps 2
```

Keep the dashboard's static server running separately on port `8000` and open
`http://localhost:8000`. The dashboard map is a local orthogonal frame centered
on the landing-site origin: positive `x_cm` is east/right and positive `y_cm` is
north/up. The perception adapter transforms camera-relative detections into
that frame and emits the rover as a `beacon` sample, so rover-follow and trail
rendering use the same coordinates as the hazards. Coordinates are centimeters;
the map grid labels convert them to meters.

The perception replay currently estimates rover pose from the configured
starting point, heading, and constant speed (`--speed`, default 30 cm/s;
heading defaults to 0 degrees, north, clockwise-positive). It is not GPS or
hardware odometry, so real-world position accuracy depends on replacing that
estimate with the vehicle's actual pose source. To use a WebSocket server on a
different host or port, set the page's `ws` query parameter as described above.

## Link blackout control

The Link status panel's **KILL THE LINK** button sends
`{"type":"set_blackout","on":true}`. After a snapshot confirms
`link.blackout === true`, the button becomes **RESTORE LINK**. It sends the same
message with `on:false`; the label changes back only when a later snapshot
confirms `link.blackout === false`. While waiting for confirmation, the panel
shows `waiting for server...`; if there is no acknowledgement within 3 seconds,
it shows `server did not acknowledge`. The button is disabled when the
WebSocket is not open, with a tooltip explaining why.

## Testing aging and link loss

Run the mock and dashboard as described above:

- `FRESH` appears for hazards younger than 5 seconds. Newly introduced mock
  hazards provide fresh examples.
- `AGING` appears when a hazard reaches 5 seconds; `STALE` begins at 30
  seconds. The mock introduces more detections over time, so leave the page open
  to see all three stages.
- `EXPIRED` begins after 120 seconds. Uncheck **Hide expired** in the map
  controls to display expired detections; they are removed after 600 seconds.
- `DEGRADED` occurs when there has been no received packet for more than 3
  seconds outside a blackout. The mock creates a four-second packet gap every
  30 seconds.
- `BLACKOUT` appears during the mock's automatic 10-second blackout every
  minute, or after using **KILL THE LINK** and receiving a confirming snapshot.
- `NO CONTACT` is visible after the WebSocket connects and before its first
  snapshot arrives.
- The map's `SIGNAL LOST` banner appears when the last-packet age exceeds 10
  seconds; the mock's automatic blackout demonstrates it.
- `SERVER DISCONNECTED` appears if the WebSocket mock is stopped while the
  static HTTP server remains running.

Press **K** to toggle reference markers at (+500, 0), (0, +500), (-500, 0), and
(0, -500) cm, labeled E, N, W, and S. Press **D** to toggle the debug panel,
which shows the last raw message, snapshot rate in Hz, average snapshot size,
WebSocket state, total contract-issue count, and recent violations.

## Aging and uncertainty

Hazard age is `age_ms + local elapsed time since the snapshot arrived`.
The stages use the code's thresholds: `FRESH < 5,000 ms`, `AGING < 30,000 ms`,
`STALE <= 120,000 ms`, and `EXPIRED > 120,000 ms`. Fresh markers retain their
class color at full opacity; aging markers keep their class color at reduced
opacity; stale markers are gray with a dashed outline. Expired markers remain
gray and dashed when **Hide expired** is off, and are removed after 600 seconds.
The top bar's **Last packet** indicator is green below 2 seconds, amber from 2
through 10 seconds, and red above 10 seconds.

The uncertainty radius is
`min(300 cm, geometry_cm + 3 cm/s * age_seconds)`. When supplied,
`geometry_cm = sigma_cm`. If `sigma_cm` is missing, geometry is estimated as
`10 cm + 0.05 * distance_from_rover_cm * (1 - conf / 7)`; the map labels this
value estimated. These fallback constants and the 3 cm/s age growth are in
`frontend/src/config.js`. Until a rover sample is available, the UI identifies
the missing rover range and uses only the configured 10 cm base estimate. The
total radius is capped at 300 cm.

The rover position uncertainty circle grows at an assumed maximum speed of
5 cm/s based on elapsed time since the latest rover sample. This speed is a
configurable assumption with a TODO to confirm it with the team; the dashboard
does not infer heading or rover speed.

## Map controls and replay

- Use the mouse wheel over the map to zoom and drag to pan. Reset view returns
  to the landing-site origin; Follow rover keeps the latest rover position at
  the map center.
- Hover over a hazard for its class, coordinates, confidence, age, and ID.
  Click a hazard or a hazard-list row to select it and show its details.
- Use the class checkboxes and **Hide expired** to filter the map. Uncertainty
  circles and the rover path can be toggled independently.
- **Pause live** freezes the displayed map while telemetry continues to be
  stored. Scrub the time slider to inspect the last five minutes, then choose
  **Resume live** to return to current telemetry.
- Keyboard shortcuts: Space pauses/resumes, R resets the map view, F toggles
  Follow rover, K toggles the reference markers, and D toggles the debug panel.
  Shortcuts are ignored while typing in a form control.
- Open **Accessibility options** using the round button fixed at the bottom-left
  of the dashboard to switch between the dark and light palettes.
- **K** and **D** remain map shortcuts; `Ctrl+Plus` and `Ctrl+Minus` are not
  intercepted, so browser zoom continues to work normally.

## Accessibility

The bottom-left **Accessibility options** button provides light/dark themes,
interface zoom (80%–175%, independent of map zoom), and optional voice guidance.
Motion is reduced automatically when the operating system's
`prefers-reduced-motion` preference is enabled. Theme and zoom preferences are
saved locally in the browser's `localStorage` under
`crater-accessibility-settings`; the dashboard does not send them to a service.

The optional voice assistant is text-to-speech only and uses locally installed
system voices through the browser's speech synthesis API, so it works offline.
Speech recognition is intentionally not used because it requires cloud
services. Spoken announcements are also mirrored in a polite screen-reader
announcement region.

## Sidebar

Press **B** or use the sidebar toggle to collapse or expand Mission Tools. It
opens by default at 1100 px and wider and is collapsed below that width. Its
sections are:

1. **Explain this detection** — confidence, geometry/age uncertainty breakdown,
   the reliability rule, position, bearing, and detector notes for the selected
   hazard.
2. **Event log** — mission-time events, newest first, with type filters and SIM
   filtering.
3. **Bandwidth budget** — receive rate, packet size, JSON estimate, compression
   ratio, and link counters. Optional teammate measurements are labeled
   measured; computed values are labeled estimated.
4. **Scenario checklist** — editable demo steps, with progress saved locally.
5. **Time warp** — increases displayed hazard ages and contact timers by 0–300
   seconds without modifying stored telemetry or the mission clock.
6. **Link scenarios** — Clear link is a local preview with zero displayed loss;
   Noisy link hides approximately 30% of incoming snapshots and is preview
   only; Live telemetry returns to unmodified live values. Long blackout
   requests a 60-second server blackout.
7. **Scenario player** — deterministic, fixed-seed, three-minute offline
   mission with rover movement, eight hazards, a 20-second blackout, pause,
   restart, and 1×/2×/4× speed.
8. **Projection lab** — planned Phase 3 work for testing teammate A's camera
   projection against supplied pixel test cases.
9. **Link lab** — planned Phase 3 work for measuring teammate B's codec and
   lossy-link implementation.
10. **Simulation bridge** — planned Phase 3 work that connects the projection
    and link labs to separately maintained teammate modules.

Phase 3 lab controls and the Python bridge are not implemented in this phase.

## Simulation

The offline scenario player uses its own generated snapshot state. The map
displays either the live telemetry state or the simulated state, never a merge
of both. Simulated hazards and events carry a **SIM** tag. A persistent amber
banner reads **SIMULATION - not rover data** while playback is active. Stopping
playback immediately restores the live display and discards the generated
scenario state. If the telemetry connection remains down for more than 10
seconds, the dashboard offers to start the player; it never switches to
simulation without operator confirmation.

Time warp is a display-only age offset. It does not change `t_ms`, stored hazard
ages, or real timers. Clear link and Noisy link are local previews. Clear link
shows zero loss without modifying live telemetry; the Noisy link preview
discards roughly 30% of incoming snapshots from its displayed view. Use Live
telemetry to return to unmodified live values. The long-blackout control is
explicitly marked **sends to server**. It sends `set_blackout` with
`on: true`, shows a 60-second countdown, and then sends `on: false`; each state
is confirmed from `link.blackout`. The dashboard does not send any other
control message to the telemetry server.

The possible future `set_link` message for teammate B is a proposal only and
is not sent by the dashboard:

```json
{"type":"set_link","loss_pct":30,"delay_ms":0}
```

## Simulation lab

The lab is planned for Phase 3 and the dashboard currently works without it.
The planned local-only bridge is `ws://localhost:8766`; it must stay separate
from the live rover WebSocket on port 8765 and must never write into live
telemetry state.

The projection entry points belong to teammate A: `A_PROJECT` maps camera
pixels to ground coordinates and uncertainty, and `A_DETECT` detects objects
in a frame. The protocol entry points belong to teammate B: `B_CODEC` encodes,
decodes, and measures packet/CRC data, and `B_LINK` simulates loss, delay,
duplicates, reordering, and redundancy. Each entry point is intended to be
replaceable, with an explicitly labeled dashboard fallback when a teammate
module is unavailable.

The future lab startup option is `python .\run_demo.py --lab` from the
repository root. It is not runnable yet: `run_demo.py`, the bridge, and the
Phase 3 lab interfaces have not been added.
