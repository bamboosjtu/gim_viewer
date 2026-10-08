export interface LineFamPropertyPayload {
  source_path: string;
  normalized_path: string;
  file_name_lower: string;
  display_key: string | null;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

export interface LineDevPropertyPayload {
  source_path: string;
  normalized_path: string;
  file_name_lower: string;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

export interface LineFamPropertyRecord {
  source_path: string;
  normalized_path: string;
  file_name_lower: string;
  display_key: string | null;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

export interface LineDevPropertyRecord {
  source_path: string;
  normalized_path: string;
  file_name_lower: string;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}
