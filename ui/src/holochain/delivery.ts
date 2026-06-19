/**
 * Wrapper pour le zome parcel (coordinateur Filenymous).
 *
 * Ce module orchestre :
 *  - La création de parcels (create_parcel)
 *  - La consultation des parcels envoyés / reçus
 *  - La confirmation de téléchargement
 *  - La révocation
 *
 * Pour la livraison via lien (destinataire sans Holochain),
 * voir webBridgeGetParcel() qui utilise le Holo Web Bridge.
 */

import type { ActionHash, EntryHash } from "@holochain/client";
import { callZome, webBridgeGet } from "./client";
import type { CreateParcelInput, ParcelOutput } from "./types";

export const parcelZome = {
  /** Crée un parcel sur le DHT + notifie l'agent destinataire si disponible. */
  createParcel(input: CreateParcelInput): Promise<ParcelOutput> {
    return callZome<ParcelOutput>("parcel", "create_parcel", input);
  },

  /** Récupère un parcel par son EntryHash. Null si introuvable ou expiré. */
  getParcel(parcelEh: EntryHash): Promise<ParcelOutput | null> {
    return callZome<ParcelOutput | null>("parcel", "get_parcel", parcelEh);
  },

  /** Liste tous les parcels envoyés par l'agent courant. */
  getMySentParcels(): Promise<ParcelOutput[]> {
    return callZome<ParcelOutput[]>("parcel", "get_my_sent_parcels", null);
  },

  /**
   * Liste les parcels en attente pour un contact_hash donné.
   * Utilisé par le destinataire pour voir ses fichiers entrants.
   */
  getPendingParcelsForContact(contactHash: string): Promise<ParcelOutput[]> {
    return callZome<ParcelOutput[]>("parcel", "get_pending_parcels_for_contact", contactHash);
  },

  /** Enregistre un téléchargement sur le DHT. */
  confirmDownload(parcelEh: EntryHash): Promise<ActionHash> {
    return callZome<ActionHash>("parcel", "confirm_download", parcelEh);
  },

  /** Révoque un parcel (seul l'expéditeur peut révoquer). */
  revokeParcel(parcelEh: EntryHash): Promise<ActionHash> {
    return callZome<ActionHash>("parcel", "revoke_parcel", parcelEh);
  },
};

/**
 * Récupère un ParcelManifest via Holo Web Bridge (HTTP GET).
 * Utilisé par le ReceivePanel en mode sans conducteur.
 */
export async function webBridgeGetParcel(parcelEhB64: string): Promise<ParcelOutput | null> {
  try {
    return await webBridgeGet<ParcelOutput>(`zome/parcel/get_parcel/${parcelEhB64}`);
  } catch {
    return null;
  }
}
