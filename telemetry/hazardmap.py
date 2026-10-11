"""Hazard identity (class + 1 m grid cell) and Mission Control's belief map."""
from .codec import CLASS_NAMES, Detection

CELL_CM = 100  # one hazard = one (class, 1 m cell)


def cell_key(class_name: str, x_cm: int, y_cm: int):
    return (class_name, x_cm // CELL_CM, y_cm // CELL_CM)


def det_key(d: Detection):
    return cell_key(CLASS_NAMES.get(d.class_id, f"class{d.class_id}"), d.x_cm, d.y_cm)


class MissionMap:
    """Latest known detection per hazard. Use as Receiver(on_frame=mm.update)."""

    def __init__(self, max_cells: int = 1024):
        self.max_cells = max_cells
        self.cells = {}

    def update(self, frame: dict) -> int:
        """Merge a decoded frame dict. Returns the number of NEW hazards learned."""
        new = 0
        for d in frame["detections"]:
            k = cell_key(d["class"], d["x_cm"], d["y_cm"])
            cur = self.cells.get(k)
            if cur is None:
                new += 1
                self.cells[k] = {**d, "first_rx_ms": frame["rx_ms"], "rx_ms": frame["rx_ms"]}
            elif d["ts_ms"] >= cur["ts_ms"]:
                self.cells[k] = {**d, "first_rx_ms": cur["first_rx_ms"], "rx_ms": frame["rx_ms"]}
        while len(self.cells) > self.max_cells:          # bounded memory
            stalest = min(self.cells, key=lambda k: self.cells[k]["ts_ms"])
            del self.cells[stalest]
        return new

    def snapshot(self, now_ms: int) -> list:
        """For Person C: every hazard with its data age (ms since observed)
        and time since last received."""
        return [{**c, "age_ms": now_ms - c["ts_ms"], "since_rx_ms": now_ms - c["rx_ms"]}
                for c in self.cells.values()]