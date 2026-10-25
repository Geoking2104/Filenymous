import { useTranslation } from "react-i18next";

export default function PrivacyPanel() {
  const { t } = useTranslation();
  return (
    <div>
      {/* Hero */}
      <div style={{ background:"linear-gradient(135deg,#0e7490,#0f766e)",borderRadius:"16px",padding:"2.5rem 2rem",color:"#fff",marginBottom:"1.5rem",textAlign:"center" }}>
        <h2 style={{ fontSize:"1.5rem",marginBottom:".5rem" }}>Confidentialité par conception</h2>
        <p style={{ fontSize:".9rem",opacity:.88,maxWidth:"480px",margin:"0 auto" }}>
          Filenymous n'est pas juste conforme au RGPD. Il est construit de façon à ce qu'il soit <em>structurellement impossible</em> pour un opérateur de lire vos fichiers.
        </p>
      </div>

      {/* Comparatif */}
      <div style={{ fontSize:".76rem",fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:".8rem" }}>
        Comparatif des solutions de transfert
      </div>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:".75rem",marginBottom:"1.5rem" }}>
        {[
          { title:"WeTransfer 🇳🇱", items:[
            ["✗","Fichiers sur serveurs AWS centralisés"],
            ["✗","Analyse des fichiers (plan gratuit, pub)"],
            ["✗","Compte obligatoire +2 Go"],
            ["✗","Soumis au Cloud Act américain"],
            ["~","Chiffrement HTTPS transit uniquement"],
          ], highlight:false },
          { title:"SwissTransfer 🇨🇭", items:[
            ["~","Serveurs en Suisse (meilleure protection)"],
            ["✗","Fichiers stockés en clair chez Infomaniak"],
            ["✓","Pas de publicité"],
            ["✗","Infomaniak peut techniquement lire vos fichiers"],
            ["✓","Gratuit jusqu'à 50 Go"],
          ], highlight:false },
          { title:"Filenymous ⟁", items:[
            ["✓","Aucun fichier sur un serveur tiers"],
            ["✓","Chiffrement E2E AES-256 dans le navigateur"],
            ["✓","Pas de compte, pas de pub, pas de cookie"],
            ["✓","Réseau P2P — pas de Cloud Act applicable"],
            ["✓","Expiration & révocation cryptographiques"],
          ], highlight:true },
        ].map(({ title, items, highlight }) => (
          <div key={title} style={{ background:"rgba(255,255,255,.05)",border:`${highlight?"2px solid var(--g1)":"1px solid var(--border)"}`,borderRadius:"14px",padding:"1.2rem",boxShadow:"var(--shadow)" }}>
            <div style={{ fontSize:".82rem",fontWeight:700,marginBottom:".8rem",color:highlight?"#6366f1":"var(--text)" }}>{title}</div>
            {items.map(([mark, text]) => (
              <div key={text} style={{ display:"flex",gap:".5rem",fontSize:".78rem",marginBottom:".45rem",alignItems:"flex-start" }}>
                <span style={{ fontWeight:700,color:mark==="✓"?"#059669":mark==="✗"?"#dc2626":"#d97706",flexShrink:0 }}>{mark}</span>
                <span style={{ color:"var(--muted)" }}>{text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Piliers */}
      <div style={{ fontSize:"1rem",fontWeight:700,color:"var(--text)",margin:"1.6rem 0 .8rem",display:"flex",alignItems:"center",gap:".5rem" }}>
        🛡 {t("privacyPanel.pillarsTitle")}
      </div>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:".75rem",marginBottom:"1.5rem" }}>
        {(["keys", "chunks", "direct", "wall", "stop", "fragment"] as const).map((k) => [
          { keys: "🔑", chunks: "🧩", direct: "🌐", wall: "🏠", stop: "⏱", fragment: "🕵️" }[k],
          t(`privacyPanel.${k}Title`),
          t(`privacyPanel.${k}`),
        ]).map(([ico, title, text]) => (
          <div key={title as string} style={{ background:"rgba(255,255,255,.05)",border:"1px solid var(--border)",borderRadius:"14px",padding:"1.1rem 1.2rem",boxShadow:"var(--shadow)" }}>
            <div style={{ fontSize:"1.4rem",marginBottom:".45rem" }}>{ico}</div>
            <div style={{ fontSize:".85rem",fontWeight:700,marginBottom:".3rem" }}>{title as string}</div>
            <div style={{ fontSize:".78rem",color:"var(--muted)",lineHeight:1.55 }}>{text as string}</div>
          </div>
        ))}
      </div>

      {/* Mentions légales */}
      <div style={{ fontSize:"1rem",fontWeight:700,margin:"1.6rem 0 .8rem" }}>📋 Mentions légales & RGPD</div>
      <div style={{ background:"var(--bg)",border:"1px solid var(--border)",borderRadius:"10px",padding:"1rem 1.2rem",fontSize:".8rem",color:"var(--muted)",lineHeight:1.65 }}>
        {(["controller", "data", "erasure", "hosting"] as const).map((k) => [t(`pz.legal.${k}Title`), t(`pz.legal.${k}`)]).map(([h, p]) => (
          <div key={h as string} style={{ marginBottom:".9rem" }}>
            <strong style={{ color:"var(--text)",fontSize:".83rem" }}>{h as string}</strong><br/>
            {p as string}
          </div>
        ))}
      </div>
    </div>
  );
}
