import { useParams } from "react-router-dom";

// Phase 1 stand-in for the real views (built in Phase 5). It proves the
// route resolves and that a deep link restores the right params on reload.
export function Placeholder({ name }: { name: string }) {
  const params = useParams();
  return (
    <section>
      <h1>{name}</h1>
      <p>This view is built in Phase 5.</p>
      {Object.keys(params).length > 0 && (
        <dl className="route-params">
          {Object.entries(params).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
