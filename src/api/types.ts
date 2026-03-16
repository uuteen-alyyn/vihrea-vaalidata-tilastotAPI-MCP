// Raw PxWeb API response types
// Docs: https://pxdata.stat.fi/API-description_SCB.pdf

/** Node in a database listing. type: l=sublevel, t=table, h=heading */
export interface PxWebNode {
  id: string;
  type: 'l' | 't' | 'h';
  text: string;
}

/** Table metadata returned by GET on a table URL */
export interface PxWebTableMetadata {
  title: string;
  variables: PxWebVariable[];
}

export interface PxWebVariable {
  code: string;
  text: string;
  values: string[];
  valueTexts: string[];
  elimination?: boolean;
  time?: boolean;
}

/** POST body sent to query a table */
export interface PxWebQuery {
  query: PxWebQueryItem[];
  response: { format: 'json' | 'csv' | 'px' | 'xlsx' | 'json-stat' | 'json-stat2' };
}

export interface PxWebQueryItem {
  code: string;
  selection: {
    /** item=explicit list, all=wildcard, top=first N (latest N for time), agg=aggregation, vs=alt value set */
    filter: 'item' | 'all' | 'top' | 'agg' | 'vs';
    values: string[];
  };
}

/** JSON response from a table data query */
export interface PxWebResponse {
  columns: PxWebColumn[];
  comments?: PxWebComment[];
  data: PxWebDataRow[];
}

/** Column descriptor in a PxWeb JSON response */
export interface PxWebColumn {
  code: string;
  text: string;
  /** d=dimension, t=time dimension, c=measure/value */
  type: 'd' | 't' | 'c';
  unit?: string;
  comment?: string;
}

export interface PxWebDataRow {
  key: string[];
  values: string[];
  comment?: string[];
}

export interface PxWebComment {
  variable: string;
  value: string;
  comment: string;
}
