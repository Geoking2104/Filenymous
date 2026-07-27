import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("# Add to push-server/.env and ui/.env\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`\n# UI (Vite)\nVITE_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VITE_PUSH_API_URL=http://localhost:3091`);
