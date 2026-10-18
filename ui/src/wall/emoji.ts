/**
 * Bundled, offline emoji set for the wall picker (no CDN, no fetch).
 * Keywords are FR + EN for the search box.
 */
export interface EmojiEntry {
  e: string;
  k: string;
}
export interface EmojiGroup {
  id: string;
  icon: string;
  list: EmojiEntry[];
}

const g = (id: string, icon: string, raw: string): EmojiGroup => ({
  id,
  icon,
  list: raw
    .trim()
    .split("\n")
    .map((l) => {
      const [e, ...k] = l.trim().split(" ");
      return { e: e!, k: k.join(" ") };
    }),
});

export const EMOJI_GROUPS: EmojiGroup[] = [
  g("smileys", "😀", `
😀 sourire smile grin
😃 joie happy
😄 rire laugh
😁 dents grin
😂 mdr lol tears joy
🤣 ptdr rofl
😊 content blush
🙂 léger slight smile
😉 clin wink
😍 amour love eyes
🥰 coeurs hearts love
😘 bisou kiss
😎 cool sunglasses
🤓 nerd geek
🤔 réfléchir think
🤨 sceptique skeptical
😐 neutre neutral
🙄 yeux roll eyes
😏 malin smirk
😴 dodo sleep
😮 wow surprise
😲 choc astonished
😳 gêné flushed
🥺 svp pleading
😢 triste sad cry
😭 pleurer sob
😤 frustré huff
😡 colère angry
🤯 explosion mind blown
😱 peur scream
🥳 fête party
🤩 étoiles star struck
😇 ange angel
🤗 câlin hug
🤫 chut shush
🤐 secret zip
😬 grimace
🤖 robot bot ia ai agent`),
  g("gestures", "👍", `
👍 oui pouce up yes ok
👎 non down no
👌 parfait perfect
✌️ paix victory
🤞 croise fingers crossed
🤝 accord deal handshake
👏 bravo applause clap
🙌 hourra raise hands
👐 mains open hands
🙏 merci thanks please
✋ main hand raise
👋 salut wave hello
💪 force strong
👀 regarde eyes look
🧠 cerveau brain
🫡 salut salute
🤙 appelle call
👉 droite point right
👈 gauche point left
☝️ attention point up
🫶 coeur mains heart hands`),
  g("hearts", "❤️", `
❤️ coeur rouge red heart love
🧡 orange heart
💛 jaune yellow heart
💚 vert green heart
💙 bleu blue heart
💜 violet purple heart
🖤 noir black heart
🤍 blanc white heart
💔 brisé broken heart
💖 brillant sparkling heart
💯 cent hundred
✨ étincelles sparkles
🔥 feu fire
⭐ étoile star
🌈 arc-en-ciel rainbow
☀️ soleil sun
🌙 lune moon
⚡ éclair lightning`),
  g("objects", "🎉", `
🎉 fête tada party
🎊 confettis confetti
🎁 cadeau gift
🏆 trophée trophy
🥇 premier gold medal
🚀 fusée rocket launch
💡 idée idea bulb
📌 épingle pin
📎 trombone clip attachment
📁 dossier folder
📄 document page
📝 note memo
🔒 cadenas lock secure
🔑 clé key
🛡️ bouclier shield
⏳ sablier hourglass time
⏰ réveil alarm
📷 photo camera
🎥 vidéo video
🎧 casque headphones
🎤 micro microphone
💻 ordinateur laptop
📱 téléphone phone
☕ café coffee
🍕 pizza
🍻 santé cheers
🐛 bug
🧪 test lab
⚙️ réglages settings gear
📊 sondage poll chart`),
  g("symbols", "✅", `
✅ fait done check
☑️ coché checked
❌ croix no cross
⚠️ attention warning
❓ question
❗ important exclamation
➕ plus add
➖ moins minus
🔴 rouge live red
🟢 vert green online
🟡 jaune yellow
🔵 bleu blue
⬆️ haut up
⬇️ bas down
🔁 répéter repeat
🆗 ok
🆕 nouveau new
🆘 sos help`),
];

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "👀"] as const;

export function searchEmoji(query: string, limit = 64): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: string[] = [];
  for (const group of EMOJI_GROUPS) for (const it of group.list) if (it.k.includes(q) && !out.includes(it.e)) out.push(it.e);
  return out.slice(0, limit);
}
