import { useParams } from "react-router-dom";
import { useLiveTopic } from "../lib/LiveContext";

// Detector cluster worker status, colour-coded, live from Redis streams via
// the detectors topic. The status payload arrives over the WebSocket; this
// view renders whatever the live message carries (wired fully when the
// deployment's redis_detectors config is present).
export function Detectors() {
  const { location = "", camera = "" } = useParams();
  useLiveTopic({ topic: "detectors", location, camera });

  return (
    <section>
      <h1>Detector status</h1>
      <p className="skeleton">
        Awaiting live detector status. (Requires Redis streams configured for
        this deployment.)
      </p>
    </section>
  );
}
