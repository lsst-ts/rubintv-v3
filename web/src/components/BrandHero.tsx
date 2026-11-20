import { BrandIntro } from "./BrandIntro";

// The brand band: the RubinTV logo on the left, the Simon Krughoff memorial
// in the space to its right. It heads the launcher home page and, on a
// deployment with a single location (summit, base, tucson), that location's
// page — where such a deployment opens, its launcher being one lone card.
// `paused` is BrandIntro's: hold the logo's intro on its first frame.
export function BrandHero({ paused = false }: { paused?: boolean }) {
  return (
    <div className="home-hero">
      <BrandIntro paused={paused} />
      {/* Links out to the community.lsst.org remembrance thread. */}
      <a
        className="memoriam"
        href="https://community.lsst.org/t/remembering-simon-krughoff/7344"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="memoriam-name">
          In memory of Simon Krughoff 1974&ndash;2023
        </span>
        <span className="memoriam-text">
          Who, among his many contributions to the project, helped launch
          RubinTV
        </span>
      </a>
    </div>
  );
}
