# Tilastokeskus PxWeb API — Implementation Notes

Source: https://pxdata.stat.fi/API-description_SCB.pdf (2020-11-13, Statistics Sweden)
Verified against the live API 2026-08-28.

> ## The 2026-07-01 contract change
>
> Statistics Finland rewrote how tables are addressed. Everything below reflects
> the **current** contract; the old form is recorded only where it still matters.
>
> | | Before | Now |
> |---|---|---|
> | Table id | `statfin_evaa_pxt_13sw` | `13sw` |
> | Time variable | `Vuosi` | `timeperiod_y` (91/91 active tables) |
> | Content variable | `Tiedot` | `contentscode` (91/91) |
> | Party variable | `Puolue` | `puolue_19_20230101` — **versioned, and different per table** |
> | Municipal content codes | `aanet_yht` | `kvaa-aanet_yht` — prefixed, but only for some subjects |
>
> Three things this repo learned the hard way:
>
> 1. **The new codes embed classification version dates.** They are meant to
>    change. Never hardcode one — resolve it from the table's own metadata via
>    `src/api/variable-resolver.ts`.
> 2. **The migration was not uniform.** `Alue/Äänestysalue` kept its old-style
>    code, and the whole `StatFin_Passiivi` archive was untouched.
> 3. **Variable `text` is unique within a table but not across tables.** Measured
>    on all 91 active tables: zero tables have two variables sharing a text, while
>    `'Puolue'` maps to five different codes across tables. Resolution must
>    therefore happen per table, at request time.

---

## Base URL

```
https://pxdata.stat.fi/PXWeb/api/v1/{lang}/{database}/{...levels}/{tableId}
```

- `lang`: `fi` (Finnish), `sv` (Swedish), `en` (English) — use `fi` as default
- `database`: e.g. `StatFin`, `StatFin_Passiivi` (archive, no longer updated)

## HTTP Methods

| Method | URL ending at... | Result |
|---|---|---|
| GET | `/{lang}` | List databases |
| GET | `/{lang}/{database}` | List top-level nodes |
| GET | `/{lang}/{database}/{...levels}` | List nodes at that level |
| GET | `/{lang}/{database}/{...levels}/{tableId}` | Table **metadata** (variables + values) |
| POST | `/{lang}/{database}/{...levels}/{tableId}` | Table **data** |

## Node types in listing responses

```json
[
  { "id": "evaa", "type": "l", "text": "Eduskuntavaalit" },
  { "id": "13sw.px", "type": "t", "text": "13sw -- Puolueiden kannatus..." }
]
```

- `l` = sublevel (folder)
- `t` = table
- `h` = heading (display only, no data)

## Table metadata response

```json
{
  "title": "...",
  "variables": [
    {
      "code": "kunta_109_20230101",
      "text": "Vaalipiiri ja kunta vaalivuonna",
      "values": ["SSS", "010000", "010091", ...],
      "valueTexts": ["KOKO MAA", "Helsingin vaalipiiri", "Helsinki", ...],
      "elimination": true,
      "time": false
    }
  ]
}
```

`code` is the machine identifier and changes with classification revisions.
`text` is the display name and is what this repo matches on.

- `elimination: true` → field can be omitted from query (aggregated/totalled)
- `time: true` → this is the time dimension

## POST query format

```json
{
  "query": [
    { "code": "kunta_109_20230101", "selection": { "filter": "item", "values": ["010091"] } },
    { "code": "timeperiod_y", "selection": { "filter": "top", "values": ["3"] } },
    { "code": "puolue_19_20230101", "selection": { "filter": "all", "values": ["*"] } }
  ],
  "response": { "format": "json" }
}
```

### Filter types

| Filter | Meaning |
|---|---|
| `item` | Explicit list of values |
| `all` | Wildcard — `"*"` = all values, `"01*"` = starts with 01 |
| `top` | First N values; for time variables: **latest** N periods |
| `agg` | Aggregation, e.g. `agg:ageG5` |
| `vs` | Alternative value set, e.g. `vs:regionX` |

If a variable is omitted from the query:
- If `elimination=true` and has a total value → selects that total
- If `elimination=true` but no total → sums all values
- If `elimination=false` → selects **all** values

## JSON response format

```json
{
  "columns": [
    { "code": "Alue", "text": "Kunta", "type": "d" },
    { "code": "Vuosi", "text": "Vuosi", "type": "t" },
    { "code": "Aanet", "text": "Äänimäärä", "type": "c", "unit": "kpl" }
  ],
  "data": [
    { "key": ["091", "2023"], "values": ["123456"] },
    { "key": ["091", "2019"], "values": ["115000"] }
  ]
}
```

Column types: `d`=dimension, `t`=time, `c`=measure value

Data rows: `key` array has values for `d`+`t` columns (in order), `values` array has values for `c` columns.

## Rate limits

The published figure is **10 requests per 10-second sliding window** per IP.
Measurement on 2026-08-28 shows that is not the whole policy:

| Workload | Result |
|---|---|
| 20 node-listing requests in 2.8 s | all 200 — well above the published rate |
| 20 metadata requests in 6.2 s (442 KB) | **429 on the twentieth** |
| Recovery after a 429 | 10–15 s |

So the limiter is weighted by response size, not request count, and no fixed
request rate is safe. `PxWebClient` still paces requests, but the real protection
is **retry with backoff on 429** (`RATE_LIMIT_RETRIES`), which is robust without
needing to know the exact policy.

Implication: fetching all 13 per-vaalipiiri candidate tables for a national query
is 13 metadata-sized requests and may hit a 429 partway; the client absorbs it.

## Election databases discovered

| Code | Database path | Description |
|---|---|---|
| `evaa` | `StatFin/evaa` | Eduskuntavaalit (parliamentary) — 45 tables |
| `kvaa` | `StatFin/kvaa` | Kuntavaalit (municipal) — 47 tables |
| `alvaa` | `StatFin/alvaa` | Aluevaalit (regional) |
| `euvaa` | `StatFin/euvaa` | Europarlamenttivaalit (EU parliament) |
| `pvaa` | `StatFin/pvaa` | Presidentinvaalit (presidential) |

## Geographic hierarchy clarification

- **Äänestysalue** = the smallest vote-counting unit in Finland (a polling area / voting precinct within a kunta). This is NOT a "suburban region" in a loose sense — it is the official smallest administrative unit by which votes are counted.
- **Kunta** = municipality (contains multiple äänestysalueet)
- **Vaalipiiri** = electoral district (contains multiple kuntas)
- **Koko Suomi** = national total

The per-vaalipiiri candidate tables (13t6–13ti) show **each candidate's votes broken down by äänestysalue** within that vaalipiiri. This is the finest granularity available for candidate data.

## Key tables for parliamentary elections (evaa), 2023

| Table ID | Content |
|---|---|
| `13sw` | Party votes by kunta, **1983–2023** (multi-election, very useful) |
| `13sv` | Voting by gender and kunta, 1983–2023 |
| `13sx` | Turnout by äänestysalue, 2023 |
| `13sy` | Advance voters by gender and kunta, 2019–2023 |
| `13t3` | Candidate votes by vaalipiiri (national summary), 2023 |
| `13t6` | Candidate votes by **äänestysalue** — **Helsinki** vaalipiiri, 2023 |
| `13t7` | ...Uusimaa, 2023 |
| `13t8` | ...Lounais-Suomi, 2023 |
| `13t9` | ...Satakunta, 2023 |
| `13ta` | ...Häme, 2023 |
| `13tb` | ...Pirkanmaa, 2023 |
| `13tc` | ...Kaakkois-Suomi, 2023 |
| `13td` | ...Savo-Karjala, 2023 |
| `13te` | ...Vaasa, 2023 |
| `13tf` | ...Keski-Suomi, 2023 |
| `13tg` | ...Oulu, 2023 |
| `13th` | ...Lappi, 2023 |
| `13ti` | ...Ahvenanmaa, 2023 |
| `13yh` | Results analysis / comparison 2019–2023 |
| `12i9` | Turnout 1908–2023 (long historical series) |

## Open questions for Phase 2

1. Are there equivalent per-vaalipiiri candidate-by-äänestysalue tables for 2019 and earlier in `StatFin_Passiivi`?
2. What are the exact variable codes (column names) in the candidate tables? Need to GET metadata per table.
3. Are municipal election candidate tables also split per district? (kvaa tables 14uk–14vk suggest yes)
