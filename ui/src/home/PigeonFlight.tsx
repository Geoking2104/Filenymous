import { useTranslation } from "react-i18next";

interface Props {
  pct: number;
  /** Device label of the left (sender) side. */
  from?: string;
  /** Device label of the right (receiver) side. */
  to?: string;
  /** Which side is "me". */
  self: "from" | "to";
  done?: boolean;
  failed?: boolean;
}

const W = 320;
const H = 120;
const P0 = { x: 26, y: 92 };
const P1 = { x: W / 2, y: -10 };
const P2 = { x: W - 26, y: 92 };

function bezier(t: number) {
  const u = 1 - t;
  const x = u * u * P0.x + 2 * u * t * P1.x + t * t * P2.x;
  const y = u * u * P0.y + 2 * u * t * P1.y + t * t * P2.y;
  const dx = 2 * u * (P1.x - P0.x) + 2 * t * (P2.x - P1.x);
  const dy = 2 * u * (P1.y - P0.y) + 2 * t * (P2.y - P1.y);
  return { x, y, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/** A carrier pigeon flying from sender to receiver, positioned by progress. */
export default function PigeonFlight({ pct, from, to, self, done, failed }: Props) {
  const { t } = useTranslation();
  const p = Math.max(0, Math.min(100, done ? 100 : pct));
  const { x, y, angle } = bezier(p / 100);
  const landed = p >= 100;
  const tilt = landed ? 0 : Math.max(-25, Math.min(25, angle * 0.5));
  const path = `M${P0.x},${P0.y} Q${P1.x},${P1.y} ${P2.x},${P2.y}`;
  const me = t("pz.you");
  const peer = t("pz.peer");
  return (
    <div className={`pz-flight${landed ? " is-landed" : ""}${failed ? " is-failed" : ""}`} data-testid="pigeon-flight" data-pct={p}>
      <svg viewBox={`0 0 ${W} ${H}`} className="pz-flight-svg" role="img" aria-label={t("pz.flightAria", { pct: p })}>
        <path d={path} className="pz-track" />
        <path d={path} className="pz-track-done" pathLength={100} strokeDasharray={`${p} 100`} />
        <g transform={`translate(${P0.x} ${P0.y + 12})`}><rect x="-16" y="-10" width="32" height="20" rx="3" className="pz-device" /><rect x="-20" y="10" width="40" height="3" rx="1.5" className="pz-device" /></g>
        <g transform={`translate(${P2.x} ${P2.y + 12})`}><rect x="-16" y="-10" width="32" height="20" rx="3" className="pz-device" /><rect x="-20" y="10" width="40" height="3" rx="1.5" className="pz-device" /></g>
        <g transform={`translate(${x} ${landed ? P2.y - 8 : y}) rotate(${tilt})`} className="pz-pigeon">
          <g className={landed ? "" : "pz-flap"}>
            <ellipse cx="0" cy="0" rx="11" ry="7" fill="#e2e8f0" stroke="#475569" strokeWidth="1" />
            <circle cx="10" cy="-5" r="5" fill="#cbd5e1" stroke="#475569" strokeWidth="1" />
            <circle cx="11.5" cy="-6" r="1.1" fill="#0f172a" />
            <path d="M15 -5 L19 -4 L15 -3 Z" fill="#f59e0b" />
            <path d="M-10 0 L-17 -3 L-16 4 Z" fill="#94a3b8" />
            <path className="pz-wing" d="M-3 -2 Q-8 -16 4 -14 Q6 -8 2 -2 Z" fill="#94a3b8" stroke="#475569" strokeWidth=".8" />
            <rect x="-4" y="3" width="6" height="5" rx="1" fill="#fbbf24" stroke="#92400e" strokeWidth=".6" />
          </g>
        </g>
      </svg>
      <div className="pz-pct" data-testid="pigeon-pct">{p} %</div>
      <div className="pz-ends">
        <div className="pz-end">
          <strong>{self === "from" ? me : peer}</strong>
          <span data-testid="device-from">{from || t("pz.unknownDevice")}</span>
        </div>
        <div className="pz-end pz-end-right">
          <strong>{self === "to" ? me : peer}</strong>
          <span data-testid="device-to">{to || t("pz.unknownDevice")}</span>
        </div>
      </div>
    </div>
  );
}
