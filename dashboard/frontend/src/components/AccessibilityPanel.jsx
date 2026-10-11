const { useEffect, useRef, useState } = React;
const h = React.createElement;

const UI_ZOOM_STEPS = [80, 90, 100, 115, 130, 150, 175];

export default function AccessibilityPanel({
  theme,
  uiZoom,
  voiceEnabled,
  voiceAvailable,
  volume,
  rate,
  liveMessage,
  onThemeChange,
  onZoomChange,
  onVoiceChange,
  onVolumeChange,
  onRateChange,
  onReadStatus,
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const wasOpenRef = useRef(false);
  const closePanel = () => {
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        buttonRef.current?.focus();
      }
      return undefined;
    }

    wasOpenRef.current = true;
    panelRef.current
      ?.querySelector("button:not(:disabled), input:not(:disabled)")
      ?.focus();

    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) closePanel();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const zoomIndex = UI_ZOOM_STEPS.indexOf(uiZoom);
  const voiceDisabled = !voiceAvailable;
  return h(
    "div",
    { className: "accessibility-widget", ref: containerRef },
    open
      ? h(
          "section",
          {
            className: "accessibility-panel",
            id: "accessibility-panel",
            role: "dialog",
            "aria-modal": "false",
            "aria-labelledby": "accessibility-title",
            ref: panelRef,
            tabIndex: -1,
          },
          h(
            "div",
            { className: "accessibility-panel-heading" },
            h("h2", { id: "accessibility-title" }, "Accessibility settings"),
            h(
              "button",
              {
                type: "button",
                className: "accessibility-close",
                "aria-label": "Close accessibility options",
                onClick: closePanel,
              },
              "×",
            ),
          ),
          h(
            "p",
            { className: "accessibility-intro" },
            "Adjust the display and optional voice guidance to suit you.",
          ),
          h(
            "section",
            { className: "accessibility-section", "aria-labelledby": "theme-label" },
            h("h3", { id: "theme-label" }, "THEME"),
            h(
              "button",
              {
                type: "button",
                className: "accessibility-switch",
                role: "switch",
                "aria-checked": theme === "dark",
                onClick: () => onThemeChange(theme === "dark" ? "light" : "dark"),
              },
              h("span", null, "Theme"),
              h("strong", null, theme === "dark" ? "DARK" : "LIGHT"),
            ),
          ),
          h(
            "section",
            { className: "accessibility-section", "aria-labelledby": "zoom-label" },
            h("h3", { id: "zoom-label" }, "INTERFACE ZOOM"),
            h(
              "div",
              { className: "accessibility-zoom-controls", role: "group", "aria-label": "Interface zoom" },
              h(
                "button",
                {
                  type: "button",
                  onClick: () => onZoomChange(UI_ZOOM_STEPS[Math.max(0, zoomIndex - 1)]),
                  disabled: zoomIndex <= 0,
                  "aria-label": "Decrease interface zoom",
                },
                "A-",
              ),
              h("output", { className: "accessibility-zoom-value" }, `${uiZoom}%`),
              h(
                "button",
                {
                  type: "button",
                  onClick: () =>
                    onZoomChange(
                      UI_ZOOM_STEPS[Math.min(UI_ZOOM_STEPS.length - 1, zoomIndex + 1)],
                    ),
                  disabled: zoomIndex >= UI_ZOOM_STEPS.length - 1,
                  "aria-label": "Increase interface zoom",
                },
                "A+",
              ),
              h("button", { type: "button", onClick: () => onZoomChange(100) }, "Reset"),
            ),
          ),
          h(
            "section",
            { className: "accessibility-section", "aria-labelledby": "voice-label" },
            h("h3", { id: "voice-label" }, "VOICE ASSISTANT"),
            voiceDisabled
              ? h(
                  "p",
                  { className: "voice-unavailable", role: "status" },
                  "Voice not available on this device",
                )
              : null,
            h(
              "button",
              {
                type: "button",
                className: "accessibility-switch",
                role: "switch",
                "aria-checked": voiceEnabled,
                disabled: voiceDisabled,
                onClick: () => onVoiceChange(!voiceEnabled),
              },
              h("span", null, "Voice assistant"),
              h("strong", null, voiceEnabled ? "ON" : "OFF"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "accessibility-read-status",
                disabled: voiceDisabled || !voiceEnabled,
                onClick: onReadStatus,
              },
              "Read status now",
            ),
            h(
              "label",
              { className: "accessibility-range" },
              h("span", null, `Volume · ${Math.round(volume * 100)}%`),
              h("input", {
                type: "range",
                min: 0,
                max: 1,
                step: 0.05,
                value: volume,
                disabled: voiceDisabled || !voiceEnabled,
                onChange: (event) => onVolumeChange(Number(event.target.value)),
                "aria-label": "Voice volume",
              }),
            ),
            h(
              "label",
              { className: "accessibility-range" },
              h("span", null, `Rate · ${rate.toFixed(1)}×`),
              h("input", {
                type: "range",
                min: 0.7,
                max: 1.3,
                step: 0.1,
                value: rate,
                disabled: voiceDisabled || !voiceEnabled,
                onChange: (event) => onRateChange(Number(event.target.value)),
                "aria-label": "Voice rate",
              }),
            ),
          ),
        )
      : null,
    h(
      "button",
      {
        ref: buttonRef,
        type: "button",
        className: "accessibility-launcher",
        "aria-label": "Open accessibility settings",
        title: "Accessibility settings",
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-controls": "accessibility-panel",
        onClick: () => (open ? closePanel() : setOpen(true)),
      },
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("circle", { cx: "12", cy: "12", r: "9", fill: "none", stroke: "currentColor", strokeWidth: "1.8" }),
        h("circle", { cx: "12", cy: "7", r: "1.5", fill: "currentColor" }),
        h("path", { d: "M7 10h9l-2 3h-4m1 0-2 5m2-5 4 3m-1-6 2 4h2", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }),
      ),
    ),
    h("div", { className: "visually-hidden", "aria-live": "polite", "aria-atomic": "true" }, liveMessage),
  );
}
