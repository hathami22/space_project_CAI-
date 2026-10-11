"""Stand-in for Person A: a rover circling the landing site, spotting hazards."""
import math
import random
from .codec import Detection, CLASS_BOULDER, CLASS_CRATER, CLASS_ICE, CLASS_BEACON


class FakeRover:
    def __init__(self, seed=1, n_hazards=40, radius_cm=1200, speed_cm_s=60,
                 view_cm=700, beacon_every_ms=2000):
        rng = random.Random(seed)
        self.radius, self.speed, self.view = radius_cm, speed_cm_s, view_cm
        self.beacon_every_ms = beacon_every_ms
        self._last_beacon = -10**9
        self.hazards, used = [], set()
        while len(self.hazards) < n_hazards:
            r, a = rng.uniform(500, 1700), rng.uniform(0, 2 * math.pi)
            # cell centre +-25 cm: the reported position can never cross a 1 m cell border
            cx = math.floor(r * math.cos(a) / 100) * 100 + 50
            cy = math.floor(r * math.sin(a) / 100) * 100 + 50
            if (cx, cy) in used:
                continue
            used.add((cx, cy))
            cls = rng.choices([CLASS_BOULDER, CLASS_CRATER, CLASS_ICE], [6, 3, 1])[0]
            self.hazards.append((cls, cx + rng.randint(-25, 25),
                                 cy + rng.randint(-25, 25), rng.randint(4, 7)))

    def position(self, t_ms):
        ang = self.speed * (t_ms / 1000) / self.radius
        return int(self.radius * math.cos(ang)), int(self.radius * math.sin(ang))

    def step(self, t_ms):
        """Detections visible at mission time t_ms (what A's detect() will return)."""
        rx, ry = self.position(t_ms)
        out = []
        if t_ms - self._last_beacon >= self.beacon_every_ms:
            out.append(Detection(CLASS_BEACON, 7, rx, ry, t_ms, 10.0))
            self._last_beacon = t_ms
        for cls, x, y, conf in self.hazards:
            d = math.hypot(x - rx, y - ry)
            if d <= self.view:
                out.append(Detection(cls, conf, x, y, t_ms, 10 + 0.05 * d))  # sigma grows with range
        return out