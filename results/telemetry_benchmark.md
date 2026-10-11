# Telemetry benchmark (2026-10-11 00:42)

Seeds: 30. Python 3.13.9, macOS-26.3.1-arm64-arm-64bit-Mach-O. Deterministic: seeded RNGs and a simulated clock.

## 1. Frame size: binary vs JSON

| detections/frame | binary B | B/detection | JSON B | minified JSON B | x smaller (JSON) | x smaller (minified) |
|---|---|---|---|---|---|---|
| 1 | 17.0 | 17.0 | 114.1 | 101.1 | 6.7x | 5.9x |
| 2 | 24.0 | 12.0 | 228.8 | 202.8 | 9.5x | 8.4x |
| 4 | 38.0 | 9.5 | 457.0 | 405.0 | 12.0x | 10.7x |
| 8 | 66.0 | 8.2 | 914.0 | 810.0 | 13.8x | 12.3x |
| 16 | 122.0 | 7.6 | 1826.8 | 1618.8 | 15.0x | 13.3x |
| 32 | 234.0 | 7.3 | 3653.4 | 3237.4 | 15.6x | 13.8x |

Codec speed (4 detections, 38 B): encode 353,015 frames/s, decode 418,991 frames/s (single core, pure Python).

## 2. Delivery: hazards known to Mission Control at the end

Burst loss (Gilbert-Elliott), 1.3 s one-way latency, two blackouts (17 s of 90 s).

| link loss | naive | resilient | bytes/s naive | bytes/s resilient |
|---|---|---|---|---|
| 0% | 78.4% | 96.7% | 9.6 | 38.5 |
| 10% | 69.3% | 95.2% | 9.6 | 38.5 |
| 30% | 54.9% | 91.4% | 9.6 | 38.5 |
| 50% | 37.2% | 83.8% | 9.6 | 38.5 |

## 3. Blackout recovery (10 s blackout at t = 20-30 s)

Hazards discovered DURING the blackout. Times are measured from the END of the blackout.

| link loss | strategy | recovered | first arrives | 90 % known | runs reaching 90 % |
|---|---|---|---|---|---|
| 0% | naive | 0.0% | never | never | 0% |
| 0% | resilient | 100.0% | 1.3 s | 9.7 s | 100% |
| 10% | naive | 0.0% | never | never | 0% |
| 10% | resilient | 100.0% | 1.3 s | 9.8 s | 100% |
| 30% | naive | 0.0% | never | never | 0% |
| 30% | resilient | 98.3% | 1.4 s | 15.4 s | 90% |

## 4. Test suite

`pytest`: 57 passed in 6.00s (full output in results/pytest_output.txt)
