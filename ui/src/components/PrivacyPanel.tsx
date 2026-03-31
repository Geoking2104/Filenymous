export default function PrivacyPanel() {
  return (
    <div>
      {/* Hero */}
      <div style={{ background:"linear-gradient(135deg,#6366f1,#8b5cf6)",borderRadius:"16px",padding:"2.5rem 2rem",color:"#fff",marginBottom:"1.5rem",textAlign:"center" }}>
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
            ["✓","Pas de compte, pas de pub, pas de traçage"],
            ["✓","Réseau P2P — pas de Cloud Act applicable"],
            ["✓","Expiration & révocation cryptographiques"],
          ], highlight:true },
        ].map(({ title, items, highlight }) => (
          <div key={title} style={{ background:"#fff",border:`${highlight?"2px solid #6366f1":"1px solid var(--border)"}`,borderRadius:"14px",padding:"1.2rem",boxShadow:"var(--shadow)" }}>
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
        🛡 Les piliers de sécurité du réseau Holochain
      </div>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:".75rem",marginBottom:"1.5rem" }}>
        {[
          ["🔑","Identité cryptographique","Chaque participant est une paire de clés Ed25519 générée localement. Aucune autorité centrale ne délivre d'identité. Vos actions sont signées par votre clé privée, qui ne quitte jamais votre appareil."],
          ["🧩","Fragmentation chiffrée","Les fichiers sont découpés en chunks de 256 Ko, chiffrés individuellement avec AES-256-GCM, et distribués sur des nœuds différents. Aucun nœud ne possède un fichier complet ni la clé pour le déchiffrer."],
          ["🌐","DHT sans coordinateur","La Distributed Hash Table Holochain stocke les données sans serveur maître. Pas de point unique d'attaque, de saisie ou de censure. Couper un nœud ne compromet pas les données."],
          ["📜","Source chain immuable","Chaque agent tient un journal local signé et chaîné de toutes ses actions. La falsification est détectable par le réseau sans blockchain ni consensus global coûteux."],
          ["⏱","Expiration garantie","L'expiration publie une DeleteAction sur le DHT. Les nœuds sont obligés par la DNA (contrat applicatif) de supprimer les chunks. Ce n'est pas une promesse — c'est une règle cryptographiquement validée."],
          ["🕵️","Contacts pseudonymisés","Votre email ou téléphone n'est jamais publié sur le réseau. Seul son hash SHA-256 est stocké, associé à votre clé publique. Un observateur ne peut pas reconstituer votre adresse depuis ce hash."],
        ].map(([ico, title, text]) => (
          <div key={title as string} style={{ background:"#fff",border:"1px solid var(--border)",borderRadius:"12px",padding:"1.1rem 1.2rem",boxShadow:"var(--shadow)" }}>
            <div style={{ fontSize:"1.4rem",marginBottom:".45rem" }}>{ico}</div>
            <div style={{ fontSize:".85rem",fontWeight:700,marginBottom:".3rem" }}>{title as string}</div>
            <div style={{ fontSize:".78rem",color:"var(--muted)",lineHeight:1.55 }}>{text as string}</div>
          </div>
        ))}
      </div>

      {/* Mentions légales */}
      <div style={{ fontSize:"1rem",fontWeight:700,margin:"1.6rem 0 .8rem" }}>📋 Mentions légales & RGPD</div>
      <div style={{ background:"var(--bg)",border:"1px solid var(--border)",borderRadius:"10px",padding:"1rem 1.2rem",fontSize:".8rem",color:"var(--muted)",lineHeight:1.65 }}>
        {[
          ["Responsable de traitement","Filenymous est un protocole décentralisé open-source. En l'absence de base de données centrale, il n'existe pas de responsable de traitement au sens classique du RGPD pour les fichiers transférés. Chaque utilisateur est responsable des données qu'il publie sur le DHT."],
          ["Données collectées","Le bridge de notification reçoit temporairement l'adresse de destination et le lien de transfert. Ces données ne sont pas persistées au-delà de l'envoi (TTL : 0). Aucun cookie de traçage, aucune analytics, aucune publicité."],
          ["Droit à l'effacement","L'expéditeur peut révoquer un transfert depuis l'onglet Historique. La révocation publie une suppression cryptographique sur le DHT. Les chunks sont effacés dans un délai de 24h maximum."],
          ["Hébergement","Les chunks chiffrés sont distribués sur les nœuds actifs du réseau. Aucun chunk n'est localisé sur un serveur géré par l'éditeur. La localisation géographique des nœuds est inconnue par conception."],
        ].map(([h, p]) => (
          <div key={h as string} style={{ marginBottom:".9rem" }}>
            <strong style={{ color:"var(--text)",fontSize:".83rem" }}>{h as string}</strong><br/>
            {p as string}
          </div>
        ))}
      </div>
    </div>
  );
}
