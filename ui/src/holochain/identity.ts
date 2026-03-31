import type { AgentPubKey, ActionHash } from "@holochain/client";
import { callZome } from "./client";

export const identityZome = {
  /** Publish a ContactClaim on the DHT after OTP verification */
  claimContact(contact_hash: string): Promise<ActionHash> {
    return callZome("identity", "claim_contact", { contact_hash });
  },

  /** Resolve a contact hash to an AgentPubKey — null if not found */
  getAgentForContact(contact_hash: string): Promise<AgentPubKey | null> {
    return callZome("identity", "get_agent_for_contact", contact_hash);
  },

  /** Delete this agent's ContactClaim from the DHT (RGPD erasure) */
  revokeContactClaim(contact_hash: string): Promise<ActionHash> {
    return callZome("identity", "revoke_contact_claim", contact_hash);
  },

  // ── M3: X25519 key management ───────────────────────────────────────────

  /**
   * Publish this agent's X25519 public key on the DHT.
   * @param x25519PubKeyB64 Base64-encoded raw 32-byte X25519 public key.
   */
  publishX25519Key(x25519PubKeyB64: string): Promise<ActionHash> {
    return callZome("identity", "publish_x25519_key", {
      x25519_pubkey_b64: x25519PubKeyB64,
    });
  },

  /**
   * Retrieve an agent's X25519 public key from the DHT.
   * @returns Base64-encoded 32-byte key, or null if not published.
   */
  getX25519Key(agent: AgentPubKey): Promise<string | null> {
    return callZome("identity", "get_x25519_key", agent);
  },
};
