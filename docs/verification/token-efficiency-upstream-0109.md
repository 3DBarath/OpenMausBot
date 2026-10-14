# Upstream 0.1.109 synthetic capture (2026-10-14)

Both independently based checkouts execute the same five scripted turns and two synthetic inbox reads. No real email, computer operation or model inference occurs. The capture program is unchanged from the dated comparison, and the real tool catalog has the same SHA-256.

| Measure | Upstream 0.1.109 | Standalone tool-efficiency PR |
|---|---:|---:|
| Advertised tools in first request | 108 | 15 |
| First request, serialized UTF-8 bytes | 193,783 | 28,970 |
| Total requests, including discovery | 7 | 9 |
| Total request bytes | 1,386,402 | 346,834 |
| Synthetic inbox reads | 2 | 2 |

The initial payload is 85.1% smaller and total submitted request bytes are 75.0% lower. These are serialized request sizes, **not token counts**. The configured Splash endpoint was offline during verification, so no fresh native tokenizer count, inference latency or cache hit was measured; no runner was started or changed. The native-token and timing tables remain dated to their actual prior sources in the [0.1.108 token check](token-efficiency-upstream-refresh.md) and [2026-10-11 replay report](token-efficiency-benchmark.md).

[Capture summary and exact source revisions](token-efficiency-upstream-0109-data.json). Both captured sources were clean. Later documentation-only commits do not change the request fixture. Reproduce with the documented capture program against each isolated checkout; tokenization and inference are separate optional steps and require an explicitly chosen resident runner.
