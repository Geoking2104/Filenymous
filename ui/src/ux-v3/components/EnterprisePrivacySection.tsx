const USE_CASES = [
  {
    sector: "Direction, juridique & M&A",
    title: "Partager sans créer une data room permanente",
    body: "Contrats, audits, pièces de due diligence ou dossiers de conseil circulent entre les seules parties attendues, sans compte invité à administrer ni copie destinée à rester dans un cloud tiers.",
  },
  {
    sector: "Industrie & bureaux d’études",
    title: "Échanger des livrables sensibles avec l’écosystème",
    body: "Plans, modèles, rapports de diagnostic et dossiers techniques passent du donneur d’ordre au partenaire sans devenir un nouveau stock documentaire chez un intermédiaire.",
  },
  {
    sector: "RH & fonctions support",
    title: "Limiter les traces autour des documents individuels",
    body: "Contrats, justificatifs ou dossiers collaborateurs peuvent être remis sans créer un compte nominatif supplémentaire chez un prestataire de partage.",
  },
  {
    sector: "Conseil, audit & services terrain",
    title: "Restituer directement au client",
    body: "Exports, preuves, photos et rapports sont transmis au destinataire depuis le navigateur, avec une chaîne d’échange plus courte et plus facile à documenter.",
  },
];

export default function EnterprisePrivacySection() {
  return (
    <section
      className="v3-enterprise"
      id="confidentialite-entreprises"
      aria-labelledby="v3-enterprise-title"
    >
      <header className="v3-enterprise-head">
        <span className="v3-enterprise-kicker">Entreprises · Confidentialité · RGPD</span>
        <h2 id="v3-enterprise-title">
          Échange souverain.
          <br />
          <span>Données sous votre contrôle.</span>
        </h2>
        <p>
          Filenymous est conçu comme une passerelle d’échange, pas comme un nouveau silo documentaire.
          Le contenu est chiffré côté utilisateur et le destinataire le récupère sans imposer une copie
          durable dans le cloud d’un tiers.
        </p>
      </header>

      <div className="v3-sovereignty-grid">
        <article>
          <span className="v3-sovereignty-number">01</span>
          <h3>Moins de données confiées</h3>
          <p>
            Sans stockage central permanent par défaut, le prestataire d’échange n’accumule pas une
            bibliothèque de fichiers exploitable, répliquée ou conservée au-delà du besoin.
          </p>
        </article>
        <article>
          <span className="v3-sovereignty-number">02</span>
          <h3>Moins de comptes et de métadonnées</h3>
          <p>
            Un échange sans compte nominatif réduit les identités, annuaires invités et historiques
            supplémentaires à administrer. « Anonyme » signifie ici minimisation des traces, pas
            invisibilité absolue sur le réseau.
          </p>
        </article>
        <article>
          <span className="v3-sovereignty-number">03</span>
          <h3>Une juridiction maîtrisable</h3>
          <p>
            En choisissant une exploitation européenne, sans fournisseur soumis au droit américain
            ayant accès au contenu ou aux clés, l’entreprise réduit son exposition aux demandes
            extraterritoriales.
          </p>
        </article>
      </div>

      <aside className="v3-cloud-act">
        <div className="v3-cloud-act-mark" aria-hidden="true">
          §
        </div>
        <div>
          <span className="v3-enterprise-kicker">Comprendre le CLOUD Act</span>
          <h3>Ce n’est pas l’adresse du serveur qui protège les données, c’est qui peut les contrôler.</h3>
          <p>
            Le CLOUD Act permet d’exiger d’un fournisseur soumis à la juridiction américaine des
            données placées sous sa possession, sa garde ou son contrôle, même lorsqu’elles sont
            hébergées hors des États-Unis. Une passerelle chiffrée et souveraine réduit ce risque si
            aucun acteur concerné ne possède durablement le contenu ni les moyens de le déchiffrer.
            Ce résultat dépend toujours de l’hébergement, des sous-traitants, de la gestion des clés
            et des journaux réellement retenus par l’entreprise.
          </p>
        </div>
      </aside>

      <div className="v3-use-cases">
        <div className="v3-use-cases-head">
          <span className="v3-enterprise-kicker">Cas d’usage</span>
          <h3>Un canal court pour les documents qui n’ont rien à faire dans un cloud de plus.</h3>
        </div>
        <div className="v3-use-case-grid">
          {USE_CASES.map((item) => (
            <article key={item.title}>
              <span>{item.sector}</span>
              <h4>{item.title}</h4>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="v3-rgpd-note">
        <strong>Ce que Filenymous simplifie — et ce qu’il ne remplace pas.</strong>
        <p>
          La minimisation, le chiffrement et l’absence de conservation inutile soutiennent les
          principes de protection dès la conception. Ils ne dispensent pas le responsable de
          traitement de définir une finalité et une base légale, d’informer les personnes, de gérer
          les droits, les durées, le registre, les habilitations et, si nécessaire, une AIPD ou une
          analyse d’impact des transferts. Cette présentation est informative et ne constitue pas un
          avis juridique.
        </p>
      </div>

      <footer className="v3-enterprise-sources">
        <span>Sources officielles</span>
        <a
          href="https://www.cnil.fr/fr/les-outils-de-la-conformite/transferer-des-donnees-hors-de-lue"
          target="_blank"
          rel="noreferrer"
        >
          CNIL · Transferts hors UE
        </a>
        <a
          href="https://www.edpb.europa.eu/system/files/2025-06/edpb_guidelines_202402_article48_v2_en.pdf"
          target="_blank"
          rel="noreferrer"
        >
          CEPD · Article 48 du RGPD
        </a>
        <a
          href="https://www.justice.gov/archives/opa/pr/justice-department-announces-publication-white-paper-cloud-act"
          target="_blank"
          rel="noreferrer"
        >
          US DOJ · CLOUD Act
        </a>
      </footer>
    </section>
  );
}
