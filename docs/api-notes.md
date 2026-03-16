# Tilastokeskus PxWeb API — Implementation Notes

Source: https://pxdata.stat.fi/API-description_SCB.pdf (2020-11-13, Statistics Sweden)

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
  { "id": "statfin_evaa_pxt_13sw", "type": "t", "text": "Puolueen kannatus..." }
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
      "code": "Alue",
      "text": "Kunta",
      "values": ["091", "049", ...],
      "valueTexts": ["Helsinki", "Espoo", ...],
      "elimination": true,
      "time": false
    }
  ]
}
```

- `elimination: true` → field can be omitted from query (aggregated/totalled)
- `time: true` → this is the time dimension

## POST query format

```json
{
  "query": [
    { "code": "Alue", "selection": { "filter": "item", "values": ["091", "049"] } },
    { "code": "Vuosi", "selection": { "filter": "top", "values": ["3"] } },
    { "code": "Puolue", "selection": { "filter": "all", "values": ["*"] } }
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

**10 requests per 10-second sliding window** per IP address.
Excess → HTTP 429 Too Many Requests.

Implication: fetching all 13 per-vaalipiiri candidate tables for a national query = 13 requests, takes ~13 seconds minimum if done naively. The `PxWebClient` throttles automatically.

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
| `statfin_evaa_pxt_13sw` | Party votes by kunta, **1983–2023** (multi-election, very useful) |
| `statfin_evaa_pxt_13sv` | Voting by gender and kunta, 1983–2023 |
| `statfin_evaa_pxt_13sx` | Turnout by äänestysalue, 2023 |
| `statfin_evaa_pxt_13sy` | Advance voters by gender and kunta, 2019–2023 |
| `statfin_evaa_pxt_13t3` | Candidate votes by vaalipiiri (national summary), 2023 |
| `statfin_evaa_pxt_13t6` | Candidate votes by **äänestysalue** — **Helsinki** vaalipiiri, 2023 |
| `statfin_evaa_pxt_13t7` | ...Uusimaa, 2023 |
| `statfin_evaa_pxt_13t8` | ...Lounais-Suomi, 2023 |
| `statfin_evaa_pxt_13t9` | ...Satakunta, 2023 |
| `statfin_evaa_pxt_13ta` | ...Häme, 2023 |
| `statfin_evaa_pxt_13tb` | ...Pirkanmaa, 2023 |
| `statfin_evaa_pxt_13tc` | ...Kaakkois-Suomi, 2023 |
| `statfin_evaa_pxt_13td` | ...Savo-Karjala, 2023 |
| `statfin_evaa_pxt_13te` | ...Vaasa, 2023 |
| `statfin_evaa_pxt_13tf` | ...Keski-Suomi, 2023 |
| `statfin_evaa_pxt_13tg` | ...Oulu, 2023 |
| `statfin_evaa_pxt_13th` | ...Lappi, 2023 |
| `statfin_evaa_pxt_13ti` | ...Ahvenanmaa, 2023 |
| `statfin_evaa_pxt_13yh` | Results analysis / comparison 2019–2023 |
| `statfin_evaa_pxt_12i9` | Turnout 1908–2023 (long historical series) |

## Open questions for Phase 2

1. Are there equivalent per-vaalipiiri candidate-by-äänestysalue tables for 2019 and earlier in `StatFin_Passiivi`?
2. What are the exact variable codes (column names) in the candidate tables? Need to GET metadata per table.
3. Are municipal election candidate tables also split per district? (kvaa tables 14uk–14vk suggest yes)
