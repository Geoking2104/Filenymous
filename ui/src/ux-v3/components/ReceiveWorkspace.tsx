import { useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  onOpen?: (payload: string) => void;
}

export default function ReceiveWorkspace({ onOpen }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onOpen?.(v);
  };

  return (
    <div>
      <div className="v3-step">{t("ux.receiveStep")}</div>
      <p className="v3-muted">{t("ux.receiveHint")}</p>
      <div className="v3-drop" style={{ minHeight: 120 }}>
        <div className="v3-drop-bird" style={{ fontSize: "1.8rem" }} aria-hidden="true">
          📥
        </div>
        <strong>{t("ux.receiveDropTitle")}</strong>
      </div>
      <div className="v3-receive-row">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("ux.receivePlaceholder")}
          aria-label={t("ux.receiveAria")}
        />
        <button
          type="button"
          className="v3-btn-primary"
          style={{ width: "auto", margin: 0, padding: "0.9rem 1.2rem" }}
          onClick={submit}
          disabled={!value.trim()}
        >
          {t("ux.receiveOpen")}
        </button>
      </div>
      <div className="v3-status" style={{ marginTop: "1.2rem" }}>
        <span className="v3-pulse" />
        {t("ux.receiveStatus")}
      </div>
    </div>
  );
}
