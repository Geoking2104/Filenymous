import { useEffect, useMemo, useState } from "react";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { deriveWalletAddresses, type WalletAddresses } from "../wallet/addresses";
import { buildSendConfirmation, type SendConfirmation } from "../wallet/sendModel";
import { getNetwork, WALLET_NETWORKS } from "../wallet/networks";
import type { Chain } from "../wallet/types";
import { decryptSeed, deleteVault, encryptSeed, loadVault, saveVault } from "../wallet/vault";

type VaultState = "loading" | "missing" | "locked" | "unlocked";

const emptyAddresses: WalletAddresses = {
  ethSepolia: "",
  ethMainnet: "",
  btcSignet: "",
  btcTestnet: "",
  btcMainnet: "",
};

function AddressRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display:"flex",gap:".6rem",alignItems:"center",padding:".65rem .75rem",border:"1px solid var(--border)",borderRadius:"10px",background:"var(--bg)",marginBottom:".5rem" }}>
      <div style={{ flex:1,minWidth:0 }}>
        <div style={{ fontSize:".72rem",fontWeight:700,color:"var(--muted)",marginBottom:".15rem" }}>{label}</div>
        <div style={{ fontSize:".74rem",fontFamily:"monospace",wordBreak:"break-all" }}>{value || "Verrouille"}</div>
      </div>
      <button className="btn-ghost btn-sm" disabled={!value} onClick={() => {
        navigator.clipboard.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}>
        {copied ? "Copie" : "Copier"}
      </button>
    </div>
  );
}

export default function WalletPanel() {
  const [vaultState, setVaultState] = useState<VaultState>("loading");
  const [password, setPassword] = useState("");
  const [importPhrase, setImportPhrase] = useState("");
  const [recoveryPhrase, setRecoveryPhrase] = useState("");
  const [addresses, setAddresses] = useState<WalletAddresses>(emptyAddresses);
  const [message, setMessage] = useState("");
  const [chain, setChain] = useState<Chain>("eth");
  const [mainnetEnabled, setMainnetEnabled] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("0.001");
  const [confirmation, setConfirmation] = useState<SendConfirmation | null>(null);

  useEffect(() => {
    loadVault()
      .then((record) => setVaultState(record ? "locked" : "missing"))
      .catch((err) => {
        console.error(err);
        setMessage("Coffre wallet inaccessible.");
        setVaultState("missing");
      });
  }, []);

  const activeNetwork = useMemo(
    () => getNetwork(chain, mainnetEnabled),
    [chain, mainnetEnabled],
  );

  async function unlockWithSeed(seed: Uint8Array) {
    const derived = await deriveWalletAddresses(seed);
    setAddresses(derived);
    setVaultState("unlocked");
    setMessage("");
  }

  async function createVaultFromMnemonic(mnemonic: string) {
    if (password.length < 10) {
      setMessage("Mot de passe wallet trop court.");
      return;
    }
    const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    if (!validateMnemonic(normalized, wordlist)) {
      setMessage("Phrase de recuperation invalide.");
      return;
    }
    const seed = mnemonicToSeedSync(normalized);
    const record = await encryptSeed(seed, password);
    await saveVault(record);
    await unlockWithSeed(seed);
    setRecoveryPhrase(normalized);
    setPassword("");
  }

  async function createNewVault() {
    const mnemonic = generateMnemonic(wordlist, 128);
    await createVaultFromMnemonic(mnemonic);
  }

  async function importVault() {
    await createVaultFromMnemonic(importPhrase);
    setImportPhrase("");
  }

  async function unlockVault() {
    const record = await loadVault();
    if (!record) {
      setVaultState("missing");
      return;
    }
    try {
      const seed = await decryptSeed(record, password);
      await unlockWithSeed(seed);
      setPassword("");
    } catch (err) {
      console.error(err);
      setMessage("Mot de passe incorrect.");
    }
  }

  async function resetVault() {
    if (!confirm("Supprimer le coffre wallet local ?")) return;
    await deleteVault();
    setVaultState("missing");
    setAddresses(emptyAddresses);
    setConfirmation(null);
    setRecoveryPhrase("");
  }

  function prepareSend() {
    try {
      const next = buildSendConfirmation({
        chain,
        network: activeNetwork.id,
        mainnetEnabled,
        recipient,
        amount,
        fee,
      });
      setConfirmation(next);
      setMessage("");
    } catch (err) {
      setConfirmation(null);
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (vaultState === "loading") {
    return <div className="card"><div className="card-label">Wallet local</div><div className="empty">Chargement du coffre...</div></div>;
  }

  if (vaultState === "missing") {
    return (
      <div>
        <div className="card">
          <div className="card-label">Wallet local verrouille</div>
          {message && <div className="warn-box">{message}</div>}
          <div className="form-row">
            <label className="form-label">Mot de passe du coffre</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="10 caracteres minimum" />
          </div>
          <button className="btn-primary btn-full" disabled={password.length < 10} onClick={createNewVault}>
            Creer un wallet BTC/ETH local
          </button>
        </div>

        <div className="card">
          <div className="card-label">Importer une phrase BIP39</div>
          <textarea value={importPhrase} onChange={(e) => setImportPhrase(e.target.value)} placeholder="12 ou 24 mots" />
          <button className="btn-ghost btn-full" style={{ marginTop:".8rem" }} disabled={password.length < 10 || !importPhrase.trim()} onClick={importVault}>
            Importer dans le coffre local
          </button>
        </div>
      </div>
    );
  }

  if (vaultState === "locked") {
    return (
      <div className="card">
        <div className="card-label">Wallet verrouille</div>
        {message && <div className="warn-box">{message}</div>}
        <div className="form-row">
          <label className="form-label">Mot de passe</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn-primary btn-full" disabled={!password} onClick={unlockVault}>Deverrouiller</button>
        <button className="btn-ghost btn-full" style={{ marginTop:".7rem" }} onClick={resetVault}>Supprimer le coffre local</button>
      </div>
    );
  }

  return (
    <div>
      {recoveryPhrase && (
        <div className="card">
          <div className="card-label">Phrase de recuperation</div>
          <div className="warn-box">Notez cette phrase maintenant. Elle ne sera plus affichee apres verrouillage.</div>
          <div style={{ fontFamily:"monospace",fontSize:".82rem",wordBreak:"break-word",padding:".85rem",border:"1px solid var(--border)",borderRadius:"10px",background:"var(--bg)" }}>
            {recoveryPhrase}
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",gap:".8rem",marginBottom:"1rem" }}>
          <div className="card-label" style={{ margin:0 }}>Recevoir</div>
          <button className="btn-ghost btn-sm" onClick={() => { setVaultState("locked"); setAddresses(emptyAddresses); setRecoveryPhrase(""); }}>
            Verrouiller
          </button>
        </div>
        <AddressRow label="Ethereum Sepolia / Mainnet" value={addresses.ethSepolia} />
        <AddressRow label="Bitcoin Signet" value={addresses.btcSignet} />
        <AddressRow label="Bitcoin Mainnet" value={mainnetEnabled ? addresses.btcMainnet : ""} />
      </div>

      <div className="card">
        <div className="card-label">Envoyer</div>
        {message && <div className="warn-box">{message}</div>}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:".75rem",marginBottom:".9rem" }}>
          <div>
            <label className="form-label">Chaine</label>
            <select value={chain} onChange={(e) => { setChain(e.target.value as Chain); setConfirmation(null); }}>
              <option value="eth">ETH</option>
              <option value="btc">BTC</option>
            </select>
          </div>
          <div>
            <label className="form-label">Reseau</label>
            <div style={{ fontSize:".86rem",padding:".62rem .85rem",border:"1.5px solid var(--border)",borderRadius:"var(--radius)",background:"var(--bg)" }}>
              {WALLET_NETWORKS[activeNetwork.id].label}
            </div>
          </div>
        </div>
        <label style={{ display:"flex",alignItems:"center",gap:".55rem",fontSize:".82rem",color:"var(--muted)",marginBottom:".9rem" }}>
          <input type="checkbox" checked={mainnetEnabled} onChange={(e) => { setMainnetEnabled(e.target.checked); setConfirmation(null); }} style={{ width:"auto" }} />
          Deverrouiller les reseaux mainnet
        </label>
        <div className="form-row">
          <label className="form-label">Destinataire</label>
          <input value={recipient} onChange={(e) => { setRecipient(e.target.value); setConfirmation(null); }} placeholder={chain === "eth" ? "0x..." : "bc1... ou tb1..."} />
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:".75rem",marginBottom:".9rem" }}>
          <div>
            <label className="form-label">Montant</label>
            <input value={amount} onChange={(e) => { setAmount(e.target.value); setConfirmation(null); }} placeholder={chain === "eth" ? "0.01" : "0.0001"} />
          </div>
          <div>
            <label className="form-label">Frais estimes</label>
            <input value={fee} onChange={(e) => { setFee(e.target.value); setConfirmation(null); }} />
          </div>
        </div>
        <button className="btn-primary btn-full" onClick={prepareSend}>Preparer l'envoi</button>

        {confirmation && (
          <div style={{ marginTop:"1rem",border:"1px solid var(--border)",borderRadius:"10px",padding:"1rem",background:"var(--bg)" }}>
            <div style={{ fontSize:".82rem",fontWeight:700,marginBottom:".35rem" }}>Confirmation</div>
            <div style={{ fontSize:".78rem",color:"var(--muted)",wordBreak:"break-all" }}>Vers : {confirmation.recipient}</div>
            <div style={{ fontSize:".78rem",color:"var(--muted)" }}>Total : {confirmation.total} {chain.toUpperCase()}</div>
            <div className="warn-box" style={{ marginTop:".75rem",marginBottom:0 }}>{confirmation.irreversibleWarning}</div>
          </div>
        )}
      </div>
    </div>
  );
}
