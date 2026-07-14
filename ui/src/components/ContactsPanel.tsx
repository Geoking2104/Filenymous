/**
 * ContactsPanel — carnet d'adresses des destinataires (M3).
 *
 * Liste les personnes a qui on peut envoyer des fichiers directement :
 *  - ajout par email ou telephone (jamais publie en clair : hash SHA-256)
 *  - resolution DHT : contact_hash -> AgentPubKey -> cle X25519 publiee
 *  - statut de chiffrement (cle disponible / resolu sans cle / non resolu)
 *  - envoi direct : pre-remplit le destinataire dans SendPanel
 *
 * La suppression retire l'entree du carnet local uniquement (elle ne
 * revoque aucun ContactClaim : ceux-ci appartiennent a leurs agents).
 */

import { useState } from "react";
import { hashContact } from "../crypto/contact";
import { identityZome } from "../holochain/identity";
import { useStore } from "../store/useStore";

function isValidContact(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v);
}

function agentToB64(agent: unknown): string | null {
  if (!agent) return null;
  if (typeof agent === "string") return agent;
  try {
    return btoa(String.fromCharCode(...new Uint8Array(agent as ArrayBufferLike)));
  } catch {
    return String(agent);
  }
}

export default function ContactsPanel() {
  const {
    addressBook,
    addAddressBookEntry,
    updateAddressBookEntry,
    removeAddressBookEntry,
    setSelectedRecipient,
    setTab,
  } = useStore();

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const resolveContact = async (contact: string) => {
    const hash = await hashContact(contact.toLowerCase().trim());
    let resolvedAgent: string | null = null;
    let x25519Key: string | null = null;
    try {
      const agent = await identityZome.getAgentForContact(hash);
      if (agent) {
        resolvedAgent = agentToB64(agent);
        try {
          x25519Key = await identityZome.getX25519Key(agent);
        } catch { /* pas de cle publiee */ }
      }
    } catch { /* conducteur indisponible : entree locale seulement */ }
    return { hash, resolvedAgent, x25519Key };
  };

  const handleAdd = async () => {
    const contact = input.toLowerCase().trim();
    if (!isValidContact(contact)) return;
    setLoading(true);
    try {
      const { hash, resolvedAgent, x25519Key } = await resolveContact(contact);
      addAddressBookEntry({ contact, hash, resolvedAgent, x25519Key });
      setInput("");
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async (contact: string, hash: string) => {
    setRefreshing(hash);
    try {
      const r = await resolveContact(contact);
      updateAddressBookEntry(hash, { resolvedAgent: r.resolvedAgent, x25519Key: r.x25519Key });
    } finally {
      setRefreshing(null);
    }
  };

  const handleSendTo = (contact: string) => {
    setSelectedRecipient(contact);
    setTab("send");
  };

  return (
    <div>
      <div className="card">
        <div className="card-label">Mes contacts</div>
        <div className="info-box">
          🔐 Ajoutez les personnes a qui envoyer des fichiers directement. Si le contact a publie
          sa cle X25519 sur le DHT, la cle AES est chiffree de bout en bout (ECIES) — sans lien magique.
        </div>

        <div style={{ display: "flex", gap: ".6rem", marginBottom: "1rem" }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="email@exemple.com ou +33612345678"
          />
          <button className="btn-primary" disabled={!isValidContact(input.toLowerCase().trim()) || loading} onClick={handleAdd}>
            {loading ? <span className="spin" /> : "Ajouter"}
          </button>
        </div>

        {addressBook.length === 0 && (
          <div className="empty" style={{ padding: "1.4rem" }}>
            Aucun contact — ajoutez quelqu'un pour lui envoyer des fichiers via son identite souveraine.
          </div>
        )}

        {addressBook.map((c) => (
          <div
            key={c.hash}
            style={{ display: "flex", alignItems: "center", gap: ".85rem", padding: ".85rem 1rem", background: "#fff", border: "1px solid var(--border)", borderRadius: "12px", marginBottom: ".55rem", boxShadow: "var(--shadow)" }}
          >
            <div style={{ width: "38px", height: "38px", borderRadius: "50%", background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, flexShrink: 0 }}>
              {c.contact[0].toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: ".88rem", fontWeight: 500 }}>{c.contact}</div>
              <div style={{ fontSize: ".7rem", color: "var(--muted)", fontFamily: "monospace", marginTop: ".1rem", wordBreak: "break-all" }}>
                SHA-256 : {c.hash.slice(0, 24)}…
              </div>
              {c.x25519Key ? (
                <div style={{ fontSize: ".72rem", color: "var(--ok)", marginTop: ".1rem" }}>✓ Cle de chiffrement disponible — transfert E2E pret</div>
              ) : c.resolvedAgent ? (
                <div style={{ fontSize: ".72rem", color: "var(--warn)", marginTop: ".1rem" }}>Resolu sur le DHT — aucune cle X25519 publiee</div>
              ) : (
                <div style={{ fontSize: ".72rem", color: "var(--muted)", marginTop: ".1rem" }}>Pas encore resolu sur le DHT</div>
              )}
            </div>
            <button className="btn-ghost btn-sm" disabled={refreshing === c.hash} onClick={() => handleRefresh(c.contact, c.hash)}>
              {refreshing === c.hash ? <span className="spin" /> : "Actualiser"}
            </button>
            <button className="btn-primary btn-sm" onClick={() => handleSendTo(c.contact)}>Envoyer</button>
            <button className="btn-danger btn-sm" onClick={() => removeAddressBookEntry(c.hash)}>Retirer</button>
          </div>
        ))}

        <p style={{ fontSize: ".74rem", color: "var(--muted)", marginTop: ".6rem" }}>
          Les contacts sont stockes localement. « Retirer » ne revoque aucun ContactClaim sur le DHT.
        </p>
      </div>
    </div>
  );
}
