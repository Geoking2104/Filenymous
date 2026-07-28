# Filenymous UX v3 — React

Shell unifié : **3 modes primaires** (Envoyer · Recevoir · Salon) + tiroirs secondaires.

## Installation dans le projet

Déjà intégré sous `ui/src/ux-v3/`. `App.tsx` monte `AppUxV3` par défaut.

## Brancher dans App.tsx

```tsx
import AppUxV3 from "./ux-v3/AppUxV3";

export default function App() {
  return <AppUxV3 />;
}
```

## Fichiers

```
ux-v3/
  AppUxV3.tsx
  types.ts
  index.ts
  styles/ux-v3.css
  components/
    TopBar.tsx
    ModeSwitcher.tsx
    SendWorkspace.tsx
    ReceiveWorkspace.tsx
    RoomEntry.tsx
    BottomDock.tsx
    SecondaryDrawer.tsx
```

## Hooks à brancher

| Callback | Branchement réel |
|----------|------------------|
| `SendWorkspace.onShare` | chiffrement AES + Magic Link / ECIES contact |
| `ReceiveWorkspace.onOpen` | parser code/lien → `ReceivePanel` |
| `RoomEntry.onEnter` | `RoomPanel` lobby → `ensureRoom(kind)` |
| `SecondaryDrawer` | `ContactsPanel`, `IdentityPanel`, `HistoryPanel`, Advanced |
| `TopBar.onNotifyClick` | `NotificationCenter` |

## Principes

1. Nav primaire = 3 modes uniquement
2. Workspace unique par mode
3. Contacts / Identité / Historique / Plus en bottom sheet
4. Progressive disclosure : geste d’abord, options ensuite
