// Canonical API types re-exported from the OpenAPI-generated schema. Run
// `npm run gen:api` after backend schema changes to regenerate api-types.ts.

import type { components } from "./api-types";

type Schemas = components["schemas"];

export type LocationSummary = Schemas["LocationSummary"];
export type LocationOut = Schemas["LocationOut"];
export type CameraSummary = Schemas["CameraSummary"];
export type CameraGroupOut = Schemas["CameraGroupOut"];
export type CameraOut = Schemas["CameraOut"];
export type ChannelOut = Schemas["ChannelOut"];
export type DatePayload = Schemas["DatePayload"];
export type ExtInfoOut = Schemas["ExtInfoOut"];
export type CalendarOut = Schemas["CalendarOut"];
export type EventOut = Schemas["EventOut"];
export type NightReportOut = Schemas["NightReportOut"];
export type NightReportText = NightReportOut["text"][number];
export type ControlsOut = Schemas["ControlsOut"];
export type DetectorsConfigOut = Schemas["DetectorsConfigOut"];
export type DetectorOut = Schemas["DetectorOut"];
export type AdminMenusOut = Schemas["AdminMenusOut"];
export type AdminMenuOut = Schemas["AdminMenuOut"];
export type AdminStatusOut = Schemas["AdminStatusOut"];
export type AdminActionOut = Schemas["AdminActionOut"];
export type StatusResponse = Schemas["StatusResponse"];
export type CameraStatus = Schemas["CameraStatus"];

// A metadata payload is seq_num (string) -> { column -> value }.
export type Metadata = Record<string, Record<string, unknown>>;

// Live detector status: set name -> per-set payload (workers / numWorkers /
// text). Carried in the detectorStatus WS message's `data.detectors` and read
// from the cache by the Cluster Status view. The per-set shape is defined in
// lib/detectorUtils (SetPayload).
export type DetectorStatus = Record<string, import("./detectorUtils").SetPayload>;
