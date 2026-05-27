// Hand-written types for Phase 1. Once the backend API lands (Phase 3), the
// canonical types are generated from the OpenAPI schema into api-types.ts
// (`npm run gen:api`) and these are replaced by re-exports of those.

export interface Channel {
  name: string;
  title: string;
  label: string;
  colour: string | null;
  icon: string | null;
  per_day: boolean;
}

export interface Camera {
  name: string;
  title: string;
  online: boolean;
  channels: Channel[];
  metadata_columns: Record<string, string>;
  has_mosaic: boolean;
  has_allsky: boolean;
}

export interface Location {
  name: string;
  title: string;
  camera_groups: Record<string, string[]>;
}
