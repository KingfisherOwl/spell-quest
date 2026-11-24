"use strict";

const STORAGE_KEY = "spell-quest.progress.v1";
const ROUND_SIZE = 10;
const XP_PER_LEVEL = 50;
const $ = (id) => document.getElementById(id);
const words = WORDS.map(([spelling, meaning, clue, category, alternatives = []]) => ({
  spelling, meaning, clue, category, alternatives,
}));
const DAILY_GROUPS = [
  ["school", "lunch", "ticket", "sunny", "read"],
  ["friend", "water", "station", "flower", "write"],
  ["teacher", "bread", "park", "cloudy", "walk"],
  ["family", "milk", "bus", "garden", "swim"],
  ["music", "apple", "train", "weather", "help"],
  ["student", "room", "book", "morning", "buy"],
];

const MODE_LABELS = {
  daily: "今日の5問",
  practice: "通常練習",
  review: "苦手復習",
};

const wordsBySpelling = new Map(words.map((word) => [word.spelling, word]));
let preferredSpellingStyle = "tiles";

function localDayNumber() {
  const now = new Date();
  // 端末の年月日を日番号に変換する。時刻は使わない。
  return Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000
  );
}

function dailyQuestions(dayNumber) {
  const group = DAILY_GROUPS[dayNumber % DAILY_GROUPS.length];
  return group.map((spelling) => wordsBySpelling.get(spelling));
}

const hasSpeech = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
let progress = loadProgress();
let round;
let utterance;

function emptyProgress() {
  return {
    xp: 0,
    attempts: 0,
    correct: 0,
    status: {},
    correctByStyle: {
      tiles: {},
      typing: {},
    },
  };
}

function loadProgress() {
  const initial = emptyProgress();
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return initial;
  }
  if (!stored || typeof stored !== "object") return initial;

  for (const field of ["xp", "attempts", "correct"]) {
    if (Number.isSafeInteger(stored[field]) && stored[field] >= 0) initial[field] = stored[field];
  }
  initial.correct = Math.min(initial.correct, initial.attempts);
  for (const { spelling } of words) {
    const state = stored.status?.[spelling];
    if (["seen", "review", "mastered"].includes(state)) initial.status[spelling] = state;
    for (const style of ["tiles", "typing"]) {
      if (stored.correctByStyle?.[style]?.[spelling] === true) {
        initial.correctByStyle[style][spelling] = true;
      }
    }
  }
  return initial;
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    $("storage-note").textContent = "このブラウザでは学習記録を保存できません。ページを閉じると記録が消えます。";
  }
}

function reviewWords() {
  return words.filter(({ spelling }) => progress.status[spelling] === "review");
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function updateStats() {
  $("level").textContent = `レベル ${1 + Math.floor(progress.xp / XP_PER_LEVEL)}`;
  $("xp").textContent = `${progress.xp} XP`;
  $("level-progress").value = progress.xp % XP_PER_LEVEL;
  const mastered = words.filter(({ spelling }) => progress.status[spelling] === "mastered").length;
  $("mastered").textContent = `${mastered} / ${words.length} 語`;
  $("accuracy").textContent = progress.attempts > 0
    ? `${Math.round(100 * progress.correct / progress.attempts)}%`
    : "—";
  $("review-count").textContent = reviewWords().length;
  for (const style of ["tiles", "typing"]) {
    const count = Object.keys(progress.correctByStyle[style]).length;
    const gauge = $(style + "-progress");

    gauge.max = words.length;
    gauge.value = count;
    $(style + "-count").textContent = `${count} / ${words.length} 語`;
  }
}

function startRound(mode, moveFocus = true) {
  stopSpeech();
  const dailyDay = mode === "daily" ? localDayNumber() : null;
  let pool;

  if (mode === "daily") {
    pool = dailyQuestions(dailyDay);
  } else if (mode === "review") {
    pool = shuffle(reviewWords());
  } else {
    pool = [
      ...shuffle(words.filter(({ spelling }) => !progress.status[spelling])),
      ...shuffle(words.filter(({ spelling }) => progress.status[spelling])),
    ];
  }
  round = {
    mode,
    dailyDay,
    questions: mode === "daily" ? pool : pool.slice(0, ROUND_SIZE),
    index: 0,
    correct: 0,
    xp: 0,
    missed: [],
    usedHint: false,
    answered: false,
  };
  for (const button of Object.keys(MODE_LABELS)) {
    $(button).setAttribute("aria-pressed", String(mode === button));
  }
  if (round.questions.length === 0) {
    showSummary(moveFocus);
    return;
  }
  showQuestion(moveFocus);
}

function currentWord() {
  return round.questions[round.index];
}

function showQuestion(moveFocus) {
  stopSpeech();
  round.usedHint = false;
  round.answered = false;
  const word = currentWord();
  $("summary").hidden = true;
  $("quiz").hidden = false;
  $("mode-label").textContent = MODE_LABELS[round.mode];
  $("position").textContent = `${round.index + 1} / ${round.questions.length} 問`;
  $("round-progress").max = round.questions.length;
  $("round-progress").value = round.index;
  $("category").textContent = word.category;
  $("meaning").textContent = word.meaning;
  $("clue").textContent = word.clue;
  $("answer").value = "";
  $("answer").readOnly = false;
  $("answer").removeAttribute("aria-invalid");
  $("answer-error").textContent = "";
  $("hint").disabled = false;
  $("skip").disabled = false;
  $("hint-text").textContent = "";
  $("result").textContent = "";
  $("earned-xp").hidden = true;
  $("earned-xp").textContent = "";
  $("confetti").replaceChildren();
  $("feedback").hidden = true;
  $("submit").hidden = false;
  $("next").hidden = true;
  const isDaily = round.mode === "daily";
  $("spelling-style").value = isDaily ? "tiles" : preferredSpellingStyle;
  $("spelling-style").disabled = isDaily;
  resetSpellingInput();
  if (moveFocus) {
    if ($("spelling-style").value === "typing") {
      focusSpellingInput();
    } else {
      $("meaning").focus();
    }
  }
}

function normalize(text) {
  return text.normalize("NFKC").trim().toLowerCase();
}

function grade(skipped = false) {
  if (round.answered || !currentWord() || $("quiz").hidden) return;
  const answer = normalize($("answer").value);
  if (!skipped && answer === "") {
    $("answer").setAttribute("aria-invalid", "true");
    $("spelling-style").disabled = true;
    $("undo-letter").disabled = true;
    $("letter-bank").querySelectorAll("button").forEach((tile) => { tile.disabled = true; });
    $("answer-error").textContent = "文字を選ぶか、英単語を入力しよう。";
    focusSpellingInput();
    return;
  }

  const { spelling, alternatives } = currentWord();
  if (!skipped && $("spelling-style").value === "tiles" &&
    answer.length < spelling.length) {
    $("answer-error").textContent = "すべての文字を並べてから答え合わせをしよう。";
    focusSpellingInput();
    return;
  }
  const correct = !skipped && [spelling, ...alternatives].includes(answer);
  const awarded = correct ? (round.usedHint ? 5 : 10) : 0;
  round.answered = true;
  round.xp += awarded;
  progress.attempts++;
  progress.xp += awarded;
  if (correct) {
    round.correct++;
    progress.correct++;
    const style = $("spelling-style").value === "typing" ? "typing" : "tiles";
    progress.correctByStyle[style][spelling] = true;
    if (!round.usedHint) progress.status[spelling] = "mastered";
    else if (!progress.status[spelling]) progress.status[spelling] = "seen";
  } else {
    progress.status[spelling] = "review";
    round.missed.push(currentWord());
  }
  saveProgress();
  updateStats();

  $("answer").readOnly = true;
  $("answer").removeAttribute("aria-invalid");
  $("answer-error").textContent = "";
  $("hint").disabled = true;
  $("skip").disabled = true;
  $("hint-text").textContent = "";
  $("round-progress").value = round.index + 1;
  $("feedback").classList.toggle("correct", correct);
  $("feedback").hidden = false;
  const message = correct
    ? `正解！ ${answer}${answer === spelling ? "" : `／この問題の単語は ${spelling}`}`
    : `${skipped ? "答え" : "おしい！ 正解"}は ${spelling}。苦手復習に追加しました。`;
  $("result").textContent = message;
  if (correct) showCorrectEffects(awarded);
  $("listen").hidden = !hasSpeech;
  $("submit").hidden = true;
  $("next").textContent = round.index + 1 === round.questions.length ? "結果を見る" : "次の問題";
  $("next").hidden = false;
  $("next").focus();
}

function showSummary(moveFocus = true) {
  stopSpeech();
  const total = round.questions.length;
  $("quiz").hidden = true;
  $("summary").hidden = false;
  $("summary-label").textContent = MODE_LABELS[round.mode];
  $("summary-title").textContent = total ? "セット完了！" : "苦手単語はありません";
  $("summary-detail").textContent = total
    ? `${total}問中${round.correct}問正解、${round.xp} XPを獲得しました。`
    : "通常練習で間違えた単語は、ここで練習できます。";
  $("missed-block").hidden = round.missed.length === 0;
  $("missed-list").replaceChildren(...round.missed.map(({ spelling, meaning }) => {
    const item = document.createElement("li");
    const english = document.createElement("strong");
    english.lang = "en";
    english.textContent = spelling;
    item.append(english, `　${meaning}`);
    return item;
  }));
  $("again").textContent = "通常練習を始める";
  $("review-now").hidden = reviewWords().length === 0;
  if (moveFocus) $("summary-title").focus();
}

function stopSpeech() {
  if (utterance) {
    utterance = undefined;
    window.speechSynthesis.cancel();
  }
  $("audio-status").textContent = "";
}

function speakWord() {
  if (!hasSpeech || !round.answered || $("quiz").hidden) return;
  stopSpeech();
  const speech = new SpeechSynthesisUtterance(currentWord().spelling);
  speech.lang = "en-US";
  speech.rate = 0.85;
  speech.onend = () => {
    if (utterance === speech) utterance = undefined;
  };
  speech.onerror = () => {
    if (utterance !== speech) return;
    utterance = undefined;
    $("audio-status").textContent = "発音を再生できませんでした。端末の音声設定を確認してください。";
  };
  utterance = speech;
  try {
    window.speechSynthesis.speak(speech);
  } catch {
    speech.onerror();
  }
}

$("answer-form").addEventListener("submit", (event) => {
  event.preventDefault();
  grade();
});
$("answer").addEventListener("input", () => {
  $("answer").removeAttribute("aria-invalid");
  $("answer-error").textContent = "";
});
$("hint").addEventListener("click", () => {
  const { spelling } = currentWord();
  round.usedHint = true;
  $("hint-text").textContent = `最初の文字は「${spelling[0]}」、全部で${spelling.length}文字。`;
  $("hint").disabled = true;
  focusSpellingInput();
});
$("skip").addEventListener("click", () => grade(true));
$("listen").addEventListener("click", speakWord);
$("next").addEventListener("click", () => {
  if (!round.answered || $("quiz").hidden) return;
  round.index++;
  if (currentWord()) showQuestion(true);
  else showSummary();
});
$("practice").addEventListener("click", () => {
  if (round.mode !== "practice" || $("quiz").hidden) startRound("practice");
});
$("review").addEventListener("click", () => {
  if (round.mode !== "review" || $("quiz").hidden) startRound("review");
});
$("again").addEventListener("click", () => startRound("practice"));
$("review-now").addEventListener("click", () => startRound("review"));

const pickedTiles = [];

function resetSpellingInput() {
  const useTiles = $("spelling-style").value === "tiles";
  $("tile-panel").hidden = !useTiles;
  $("typing-panel").hidden = useTiles;
  $("answer").value = "";
  $("answer").removeAttribute("aria-invalid");
  $("answer-error").textContent = "";
  pickedTiles.length = 0;
  $("letter-bank").replaceChildren();
  updateTileAnswer();

  if (!useTiles) return;

  const { spelling } = currentWord();
  const letters = shuffle([...spelling]);

  // シャッフルで元の順番になったときは、先頭の文字を末尾へ移す。
  if (letters.join("") === spelling) letters.push(letters.shift());

  for (const letter of letters) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.textContent = letter;
    tile.lang = "en";

    tile.addEventListener("click", () => {
      if (round.answered) return;
      pickedTiles.push(tile);
      tile.disabled = true;
      updateTileAnswer();
      playSpellAnimation(tile, [
        { transform: "scale(1)" },
        { transform: "scale(0.86)", offset: 0.35 },
        { transform: "scale(1)" },
      ]);

      playSpellAnimation($("tile-answer"), [
        { transform: "translateY(3px)" },
        { transform: "translateY(0)" },
      ], 150);
      focusSpellingInput();
    });

    $("letter-bank").append(tile);
  }
}

function updateTileAnswer() {
  const spelling = pickedTiles.map((tile) => tile.textContent).join("");
  $("answer").value = spelling;
  $("tile-answer").textContent = spelling || "まだ選んでいません";
  const allPlaced = pickedTiles.length === currentWord().spelling.length;
  $("tile-answer").classList.toggle("is-filled", allPlaced);
  $("undo-letter").disabled = pickedTiles.length === 0;
  $("answer-error").textContent = "";
}

function focusSpellingInput() {
  if ($("spelling-style").value === "typing") {
    $("answer").focus();
    return;
  }

  const remaining = $("letter-bank").querySelector("button:not(:disabled)");
  (remaining ?? $("submit")).focus();
}

$("undo-letter").addEventListener("click", () => {
  const tile = pickedTiles.pop();
  if (!tile || round.answered) return;
  tile.disabled = false;
  updateTileAnswer();
  tile.focus();
});

$("spelling-style").addEventListener("change", () => {
  if (round.answered || round.mode === "daily") return;

  preferredSpellingStyle = $("spelling-style").value;
  resetSpellingInput();
  if ($("spelling-style").value === "typing") {
  focusSpellingInput();
}
});

$("daily").addEventListener("click", () => {
  if (
    round.mode !== "daily" ||
    $("quiz").hidden ||
    round.dailyDay !== localDayNumber()
  ) {
    startRound("daily");
  }
});

const spellAnimations = new WeakMap();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function playSpellAnimation(element, keyframes, duration = 180) {
  if (reducedMotion.matches || typeof element.animate !== "function") return;

  // 連続入力では、同じ欄の演出を重ねずに再スタートする。
  spellAnimations.get(element)?.cancel();
  const animation = element.animate(keyframes, {
    duration,
    easing: "ease-out",
  });
  spellAnimations.set(element, animation);
}

$("answer").addEventListener("input", (event) => {
  if (round.answered || $("spelling-style").value !== "typing") return;
  if (event.isComposing || event.inputType !== "insertText") return;

  const inserted = (event.data ?? "").normalize("NFKC");
  if (!/^[a-z]+$/i.test(inserted)) return;

  playSpellAnimation($("answer"), [
    { boxShadow: "0 0 0 3px rgba(51, 137, 104, 0.38)" },
    { boxShadow: "0 0 0 0 rgba(51, 137, 104, 0)" },
  ], 200);
});

function showCorrectEffects(awarded) {
  const badge = $("earned-xp");
  const layer = $("confetti");

  badge.textContent = `+${awarded} XP`;
  badge.hidden = false;
  layer.replaceChildren();

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const colors = ["#d49a27", "#458e73", "#479ad2", "#df7670", "#9273c9"];
  const pieces = document.createDocumentFragment();

  for (let index = 0; index < 20; index++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.backgroundColor = colors[index % colors.length];
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 270}px`);
    piece.style.setProperty("--lift", `${-55 - Math.random() * 65}px`);
    piece.style.setProperty("--spin", `${(Math.random() - 0.5) * 900}deg`);
    piece.style.animationDuration = `${600 + Math.random() * 280}ms`;
    piece.addEventListener("animationend", () => piece.remove(), { once: true });
    pieces.append(piece);
  }

  layer.append(pieces);
}

updateStats();
startRound("practice", false);
