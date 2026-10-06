# RubinTV Viewer Guide

For people using the RubinTV web app to browse telescope data. Covers the
parts of the UI whose behaviour isn't obvious from looking at it.

## Camera table filters

On a camera page the **filter** control (next to **Columns**) narrows the
visible rows by a column's value. Each filter is a column, an operator, and a
value; multiple filters combine with AND. Active filters show as removable
chips, and the operators offered depend on the column's type (numeric vs text).

### Filtering by sequence number

`Seq.No` is offered as a numeric filter column alongside the metadata columns,
so you can narrow the table to a sequence number, a range, or any comparison —
e.g. "≥ 770", "between 770 and 786", "> 500".

## Sharing a view with a URL

The page URL captures the view, so copying it (or the **Copy link** button)
reproduces what you're looking at. The path selects the location and camera;
query parameters carry the rest:

| Parameter     | Example              | Meaning                                  |
| ------------- | -------------------- | ---------------------------------------- |
| `date`        | `date=2026-04-10`    | The day being viewed (UTC `dayObs`).     |
| `seq`         | `seq=786`            | The selected sequence (on a channel view). |
| `seq_filter`  | `seq_filter=gte770-lte786` | A `Seq.No` table filter (see below). |

### `seq_filter` — sequence-number filtering by URL

`seq_filter` is the URL form of a `Seq.No` table filter. It's set automatically
when you add a `Seq.No` filter in the UI (so a copied link carries it), and you
can also type it into the URL by hand to deep-link to a filtered table.

It's deliberately scoped to `Seq.No` only — there's no general "filter any
column by URL" parameter, so a link can't imply that arbitrary metadata columns
are URL-addressable.

The value is one or more **clauses joined by `-`**. Each clause is a spelled
operator token glued to its value. The grammar uses only URL-safe characters,
so links stay readable (no `%3E`-style escaping):

| You want                | `seq_filter=`        |
| ----------------------- | -------------------- |
| equals 42               | `42` (bare value) or `eq42` |
| not equal to 99         | `ne99`               |
| greater than 500        | `gt500`              |
| less than 1000          | `lt1000`             |
| at least 770            | `gte770`             |
| at most 786             | `lte786`             |
| the range 770–786       | `gte770-lte786`      |
| between 770 and 786     | `between770_786`     |
| one of 10, 20, 30       | `in10_20_30`         |

Notes:

- A **bare number** (no token) means equals, so `seq_filter=42` is the common
  "just this sequence" case.
- A **range** is simply two clauses: a lower bound and an upper bound joined by
  `-`, e.g. `gte770-lte786`. Either bound may be omitted for an open-ended
  range (`gte770` alone, or `lte786` alone).
- `between` and `in` take **compound values separated by `_`**:
  `between770_786`, `in10_20_30`.
- Operator tokens: `eq` (=), `ne` (≠), `gt` (>), `lt` (<), `gte` (≥),
  `lte` (≤), plus `between` and `in`.

Example — deep-link to AuxTel on 2026-04-10 showing only sequences 770–786:

```
/summit/auxtel?date=2026-04-10&seq_filter=gte770-lte786
```
