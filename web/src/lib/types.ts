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
export type ControlsOut = Schemas["ControlsOut"];
export type StatusResponse = Schemas["StatusResponse"];

// A metadata payload is seq_num (string) -> { column -> value }.
export type Metadata = Record<string, Record<string, unknown>>;
