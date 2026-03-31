import { useStore } from "../store/useStore";

const S = `
  footer { background:#fff; border-top:1px solid #e5e7eb; padding:1.2rem 2rem; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.8rem; }
  .footer-logo { font-size:.85rem; font-weight:800; color:#6366f1; }
  .footer-copy { font-size:.77rem; color:#9ca3af; }
  .footer-links { display:flex; gap:1.2rem; align-items:center; flex-wrap:wrap; }
  .footer-link { font-size:.8rem; color:#6b7280; text-decoration:none; display:flex; align-items:center; gap:.3rem; transition:color .15s; }
  .footer-link:hover { color:#6366f1; }
`;

export default function Footer() {
  const { setTab } = useStore();
  return (
    <>
      <style>{S}</style>
      <footer>
        <div style={{ display: "flex", alignItems: "center", gap: ".5rem" }}>
          <span className="footer-logo">⟁ Filenymous</span>
          <span style={{ color: "#e5e7eb" }}>·</span>
          <span className="footer-copy">© 2026 — Protocole open-source</span>
        </div>
        <div className="footer-links">
          <a
            href="https://github.com/filenymous/filenymous"
            target="_blank"
            rel="noreferrer"
            className="footer-link"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            GitHub
          </a>
          <button
            className="footer-link"
            style={{ border: "none", background: "transparent", cursor: "pointer" }}
            onClick={() => setTab("privacy")}
          >
            🔒 Confidentialité & RGPD
          </button>
          <a
            href="https://developer.holochain.org"
            target="_blank"
            rel="noreferrer"
            className="footer-link"
          >
            Holochain
          </a>
        </div>
      </footer>
    </>
  );
}
