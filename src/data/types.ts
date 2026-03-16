// Canonical schema types for the MCP

export type ElectionType =
  | 'parliamentary'   // Eduskuntavaalit (evaa)
  | 'municipal'       // Kuntavaalit (kvaa)
  | 'eu_parliament'   // Europarlamenttivaalit (euvaa)
  | 'presidential'    // Presidentinvaalit (pvaa)
  | 'regional';       // Aluevaalit (alvaa)

export type AreaLevel =
  | 'aanestysalue'  // Voting district / polling area
  | 'kunta'         // Municipality
  | 'vaalipiiri'    // Electoral district
  | 'koko_suomi';   // National total

/** One row in the canonical election data schema */
export interface ElectionRecord {
  election_type: ElectionType;
  year: number;
  area_level: AreaLevel;
  area_id: string;
  area_name: string;
  candidate_id?: string;
  candidate_name?: string;
  party_id?: string;
  party_name?: string;
  votes: number;
  vote_share?: number;
  rank_within_party?: number;
  rank_overall?: number;
}

/** Provenance metadata attached to every response */
export interface DataSource {
  table_ids: string[];
  query_timestamp: string;
  cache_hit: boolean;
}

export interface DataModeResponse {
  mode: 'data';
  rows: ElectionRecord[];
  source: DataSource;
}

export interface AnalysisModeResponse {
  mode: 'analysis';
  summary: Record<string, unknown>;
  tables: Record<string, unknown>;
  method: Record<string, unknown>;
  source: DataSource;
}

export type OutputMode = 'data' | 'analysis';
export type ModeResponse = DataModeResponse | AnalysisModeResponse;
