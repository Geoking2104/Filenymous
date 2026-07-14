import { useStore } from "../store/useStore";

const S = `
  footer { background:rgba(9,9,11,.92); border-top:1px solid var(--border); padding:1.2rem 2rem; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.8rem; }
  .footer-logo { font-size:.85rem; font-weight:800; color:#111827; }
  .footer-copy { font-size:.77rem; color:#9ca3af; }
  .footer-links { display:flex; gap:1.2rem; align-items:center; flex-wrap:wrap; }
  .footer-link { font-size:.8rem; color:#6b7280; text-decoration:none; display:flex; align-items:center; gap:.3rem; transition:color .15s; }
  .footer-link:hover { color:#165dff; }
`;

export default function Footer() {
  const { setTab } = useStore();

  return (
    <>
      <style>{S}</style>
      <footer>
        <div style={{ display: "flex", alignItems: "center", gap: ".5rem" }}>
          <span className="footer-logo">Filenymous</span>
          <span style={{ color: "#e5e7eb" }}>/</span>
          <span className="footer-copy">2026 open-source protocol</span>
        </div>
        <div className="footer-links">
          <a
            href="https://github.com/Geoking2104/Filenymous"
            target="_blank"
            rel="noreferrer"
            className="footer-link"
          >
            GitHub
          </a>
          <button
            className="footer-link"
            style={{ border: "none", background: "transparent", cursor: "pointer" }}
            onClick={() => setTab("advanced")}
          >
            Security
          </button>
          <a href="https://developer.holochain.org" target="_blank" rel="noreferrer" className="footer-link">
            Holochain
          </a>
        </div>
      </footer>
    </>
  );
}
