// Real Gordon Ramsay clip pool for Hell's Kitchen mode. The MP3s are NOT in
// this repo (copyrighted TV audio) — run tools/fetch-ramsay.sh to download
// them into app/public/ramsay/ (gitignored); the build then packs them into
// the APK like any static asset. This manifest is the app's source of truth
// for what exists and what to print in the chat bubble when a clip plays.
export const RAMSAY_CLIPS = [
  { file: "wheres-the-lamb-sauce.mp3", phrase: "WHERE'S THE LAMB SAUCE?!" },
  { file: "rawwww_ramsay.mp3", phrase: "It's RAAAW!" },
  { file: "gordon-you-donkey.mp3", phrase: "You DONKEY!" },
  { file: "gordon-ramsey-what-are-you-an-idiot-sandwich.mp3", phrase: "What are you? An idiot sandwich." },
  { file: "idiot-sandwich.mp3", phrase: "An idiot sandwich." },
  { file: "gordon-burnt-pan.mp3", phrase: "This pan is BURNT!" },
  { file: "gordon-teamwork.mp3", phrase: "TEAMWORK!" },
  { file: "rubber-rubber-rubber-1.mp3", phrase: "Rubber! Rubber! Rubber!" },
  { file: "its-black.mp3", phrase: "It's BLACK!" },
  { file: "gordon-nonstick-pan.mp3", phrase: "Non-stick pan… and it's STUCK." },
  { file: "how-much-is-in-the-bin.mp3", phrase: "How much is in the BIN?!" },
  { file: "rotten_ramsay.mp3", phrase: "It's ROTTEN!" },
  { file: "gordon-burnt-duck.mp3", phrase: "You've burnt the duck…" },
  { file: "youre-making-me-mad.mp3", phrase: "You're making me MAD!" },
  { file: "gordon-ramsay-you-fucing-dounut.mp3", phrase: "You doughnut!" },
  { file: "how-much-capellini.mp3", phrase: "How much capellini?!" },
  { file: "look-look-wtf-is-this.mp3", phrase: "Look! LOOK! What is THIS?!" },
];
