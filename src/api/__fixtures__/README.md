# Live PxWeb metadata fixtures

Real `GET` metadata responses from Statistics Finland, captured **2026-08-28**.
They are not hand-written, and that is the point: the hand-written fixtures
elsewhere in this repo encoded the pre-July-2026 contract and kept passing for
eight weeks after every tool had broken.

| File | Table | Why it is here |
|---|---|---|
| `metadata-13sw-parliamentary.json` | `StatFin/evaa/13sw` | Post-migration shape: versioned codes, `timeperiod_y`, `contentscode`, unprefixed `evaa_aanet` |
| `metadata-14z7-municipal.json` | `StatFin/kvaa/14z7` | Content codes re-prefixed to `kvaa-aanet_yht`, and no gender dimension |
| `metadata-13t2-mixed-codes.json` | `StatFin/evaa/13t2` | The migration was not uniform — `Alue/Äänestysalue` kept its old-style code alongside versioned ones |
| `metadata-13su-background.json` | `StatFin/evaa/13su` | Voter background; content codes use a hyphen (`evaa-lkm1`) and `evaa-pros` must not be confused with `evaa-pros_sp` |
| `metadata-2019-archive.json` | `StatFin_Passiivi/evaa/130_evaa_2019_tau_103` | The archive was never migrated: `Puolue`, `Äänestysalue`, `Puolueiden kannatus`, `Sar1`/`Sar2`. The resolver must keep this working |

## Regenerating

```bash
BASE=https://pxdata.stat.fi/PXWeb/api/v1/fi
curl -s "$BASE/StatFin/evaa/13sw.px"  | python3 -m json.tool > metadata-13sw-parliamentary.json
curl -s "$BASE/StatFin/kvaa/14z7.px"  | python3 -m json.tool > metadata-14z7-municipal.json
curl -s "$BASE/StatFin/evaa/13t2.px"  | python3 -m json.tool > metadata-13t2-mixed-codes.json
curl -s "$BASE/StatFin/evaa/13su.px"  | python3 -m json.tool > metadata-13su-background.json
curl -s "$BASE/StatFin_Passiivi/evaa/130_evaa_2019_tau_103.px" | python3 -m json.tool > metadata-2019-archive.json
```

If a regenerated fixture changes shape, that is a contract change — read the diff
before updating the tests to match it.
