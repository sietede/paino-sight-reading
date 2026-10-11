/**
 * Roland FP-30X Sight-Reading Flashcards
 * Uses Web MIDI API to read key presses directly from a connected Roland FP-30X
 * (via USB MIDI or OS-paired Bluetooth MIDI) with zero backend or storage.
 */

const NATURAL_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

// Letters that correspond to standard black keys when sharpened or flattened
const SHARP_CAPABLE_INDICES = new Set([0, 1, 3, 4, 5]); // C#, D#, F#, G#, A#
const FLAT_CAPABLE_INDICES = new Set([1, 2, 4, 5, 6]);  // Db, Eb, Gb, Ab, Bb

/**
 * Clef definitions:
 * stepOffset = 0 is always Line 1 (bottom line of the 5-line staff).
 * stepOffset = 8 is always Line 5 (top line of the 5-line staff).
 * With N ledger lines below and N ledger lines above (N in 0..4):
 *   minStep = -2 * N
 *   maxStep = 8 + 2 * N
 *
 * Treble Clef:
 *   Line 1 (stepOffset = 0) -> E4 (octave 4, letterIndex 2 -> baseDiatonic = 4*7 + 2 = 30)
 *
 * Bass Clef:
 *   Line 1 (stepOffset = 0) -> G2 (octave 2, letterIndex 4 -> baseDiatonic = 2*7 + 4 = 18)
 */
const CLEF_CONFIG = {
  treble: {
    id: 'treble',
    label: 'Treble Clef (G)',
    baseDiatonic: 30 // E4
  },
  bass: {
    id: 'bass',
    label: 'Bass Clef (F)',
    baseDiatonic: 18 // G2
  }
};

// Application State
const state = {
  clefMode: 'both',         // 'treble' | 'bass' | 'both'
  ledgerLines: 3,           // 0 | 1 | 2 | 3 | 4
  includeAccidentals: false, // checkbox state for sharps & flats
  currentCard: null,        // { clef, stepOffset, letter, octave, accidental, midi, displayName }
  wrongGhostNote: null,     // optional ghost note info when user presses wrong key
  cardStartTime: 0,
  hadErrorOnCurrentCard: false,
  isTransitioning: false,
  transitionTimer: null,

  // Session Statistics
  stats: {
    streak: 0,
    bestStreak: 0,
    correctPresses: 0,
    totalPresses: 0,
    responseTimesMs: []
  },

  // Web MIDI & Screen Wake Lock State
  midiAccess: null,
  selectedInputId: 'all',
  activeInputs: [],
  wakeLockSentinel: null
};

/**
 * Convert a clef and diatonic stepOffset (-8..16) + accidental ('', '♯', '♭')
 * into a complete note object with exact MIDI number.
 */
function buildNoteFromStep(clefId, stepOffset, accidental = '') {
  const cfg = CLEF_CONFIG[clefId];
  const diatonicAbs = cfg.baseDiatonic + stepOffset;
  const octave = Math.floor(diatonicAbs / 7);
  const letterIndex = ((diatonicAbs % 7) + 7) % 7;
  const letter = NATURAL_LETTERS[letterIndex];
  const baseSemitone = NATURAL_SEMITONES[letterIndex];

  let accidentalOffset = 0;
  if (accidental === '♯') accidentalOffset = 1;
  if (accidental === '♭') accidentalOffset = -1;

  const midi = (octave + 1) * 12 + baseSemitone + accidentalOffset;
  const displayName = `${letter}${accidental}${octave}`;

  return {
    clef: clefId,
    stepOffset,
    letter,
    letterIndex,
    octave,
    accidental,
    midi,
    displayName
  };
}

/**
 * Compute step bounds, MIDI range, and human-readable label for a clef + N ledger lines (0..4).
 */
function getClefStepBounds(clefId, ledgerLines = state.ledgerLines) {
  const n = Math.max(0, Math.min(4, Number(ledgerLines) || 0));
  const minStep = -2 * n;
  const maxStep = 8 + 2 * n;
  const lowNote = buildNoteFromStep(clefId, minStep, '');
  const highNote = buildNoteFromStep(clefId, maxStep, '');
  const ledgerDesc =
    n === 0 ? 'staff only' : n === 1 ? '1 ledger line' : `${n} ledger lines`;

  return {
    minStep,
    maxStep,
    minMidi: lowNote.midi,
    maxMidi: highNote.midi,
    rangeDescription: `${lowNote.displayName} – ${highNote.displayName} (${ledgerDesc})`
  };
}

/**
 * Convert any MIDI note number (21..108) to a readable note name.
 * Uses the current card's accidental preference if applicable.
 */
function midiToNoteName(midi, preferFlat = false) {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = ((midi % 12) + 12) % 12;
  const sharpNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const flatNames  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const name = preferFlat ? flatNames[semitone] : sharpNames[semitone];
  return `${name}${octave}`;
}

/**
 * Map a MIDI note back to a staff stepOffset on the given clef so we can
 * display a ghost indicator on the staff when the user presses a wrong key.
 */
function midiToStaffPosition(midi, clefId, preferFlat = false) {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = ((midi % 12) + 12) % 12;

  // Map semitone (0..11) to (letterIndex, accidentalSymbol)
  const sharpMap = [
    [0, ''],  [0, '♯'], [1, ''],  [1, '♯'], [2, ''],
    [3, ''],  [3, '♯'], [4, ''],  [4, '♯'], [5, ''],  [5, '♯'], [6, '']
  ];
  const flatMap = [
    [0, ''],  [1, '♭'], [1, ''],  [2, '♭'], [2, ''],
    [3, ''],  [4, '♭'], [4, ''],  [5, '♭'], [5, ''],  [6, '♭'], [6, '']
  ];

  const [letterIndex, accidental] = preferFlat ? flatMap[semitone] : sharpMap[semitone];
  const diatonicAbs = octave * 7 + letterIndex;
  const stepOffset = diatonicAbs - CLEF_CONFIG[clefId].baseDiatonic;

  return {
    stepOffset,
    accidental,
    displayName: midiToNoteName(midi, preferFlat)
  };
}

/**
 * Generate the pool of candidate flashcards for a given clef, ledger line count, and accidental setting.
 */
function getCandidatePool(clefId, includeAccidentals, ledgerLines = state.ledgerLines) {
  const { minStep, maxStep } = getClefStepBounds(clefId, ledgerLines);
  const naturals = [];
  const accidentals = [];

  for (let step = minStep; step <= maxStep; step++) {
    const natNote = buildNoteFromStep(clefId, step, '');
    naturals.push(natNote);

    if (includeAccidentals) {
      if (SHARP_CAPABLE_INDICES.has(natNote.letterIndex)) {
        accidentals.push(buildNoteFromStep(clefId, step, '♯'));
      }
      if (FLAT_CAPABLE_INDICES.has(natNote.letterIndex)) {
        accidentals.push(buildNoteFromStep(clefId, step, '♭'));
      }
    }
  }

  return { naturals, accidentals };
}

/**
 * Pick a new random flashcard based on current settings, avoiding immediate repeats.
 */
function pickRandomCard() {
  let chosenClef = state.clefMode;
  if (chosenClef === 'both') {
    chosenClef = Math.random() < 0.5 ? 'treble' : 'bass';
  }

  const { naturals, accidentals } = getCandidatePool(
    chosenClef,
    state.includeAccidentals,
    state.ledgerLines
  );
  let pool = naturals;

  // When sharps & flats are enabled, give a ~45% chance of picking a sharp/flat note
  // and ~55% chance of picking a natural note so practice feels balanced.
  if (state.includeAccidentals && accidentals.length > 0) {
    pool = Math.random() < 0.45 ? accidentals : naturals;
  }

  let candidate = pool[Math.floor(Math.random() * pool.length)];

  // Prevent showing the exact same note & clef twice in a row
  if (state.currentCard && pool.length > 1) {
    let safety = 0;
    while (
      safety < 15 &&
      candidate.clef === state.currentCard.clef &&
      candidate.midi === state.currentCard.midi &&
      candidate.accidental === state.currentCard.accidental
    ) {
      candidate = pool[Math.floor(Math.random() * pool.length)];
      safety++;
    }
  }

  return candidate;
}

/**
 * Advance to the next flashcard and render it on the SVG staff.
 */
function nextFlashcard() {
  if (state.transitionTimer) {
    clearTimeout(state.transitionTimer);
    state.transitionTimer = null;
  }
  state.isTransitioning = false;
  state.hadErrorOnCurrentCard = false;
  state.wrongGhostNote = null;
  state.currentCard = pickRandomCard();
  state.cardStartTime = performance.now();

  clearPianoKeyHighlights();
  updatePianoRangeIndicators();
  renderFlashcard();
  setFeedbackBanner('waiting', 'Play the note on your Roland FP-30X', '');
}

/**
 * Render the musical staff, clef, ledger lines, accidental, and whole note in SVG.
 */
function renderFlashcard(revealCorrect = false) {
  const svg = document.getElementById('staff-svg');
  const card = state.currentCard;
  if (!svg || !card) return;

  const clefCfg = CLEF_CONFIG[card.clef];
  const bounds = getClefStepBounds(card.clef, state.ledgerLines);
  document.getElementById('current-clef-label').textContent = clefCfg.label;
  document.getElementById('current-range-tag').textContent = bounds.rangeDescription;

  // Staff geometry constants (viewBox: 0 0 520 310)
  const staffLeft = 36;
  const staffRight = 484;
  const baseLineY = 195; // Line 1 (bottom staff line, stepOffset = 0)
  const stepSize = 10;   // 10px per diatonic step (20px between staff lines)
  const noteX = 276;     // Horizontal center for the whole note

  const stepToY = (step) => baseLineY - step * stepSize;

  let parts = [];

  // 1. Subtle staff paper background guides & double barlines
  parts.push(`
    <line x1="${staffLeft}" y1="${stepToY(8)}" x2="${staffLeft}" y2="${stepToY(0)}" stroke="#1e1d1a" stroke-width="2.5" />
    <line x1="${staffRight - 6}" y1="${stepToY(8)}" x2="${staffRight - 6}" y2="${stepToY(0)}" stroke="#1e1d1a" stroke-width="1.5" />
    <line x1="${staffRight}" y1="${stepToY(8)}" x2="${staffRight}" y2="${stepToY(0)}" stroke="#1e1d1a" stroke-width="4" />
  `);

  // 2. Five main staff lines (steps 0, 2, 4, 6, 8)
  for (let s = 0; s <= 8; s += 2) {
    const y = stepToY(s);
    parts.push(
      `<line x1="${staffLeft}" y1="${y}" x2="${staffRight}" y2="${y}" stroke="#1e1d1a" stroke-width="1.8" />`
    );
  }

  // 3. Clef SVG symbol (Treble or Bass)
  if (card.clef === 'treble') {
    parts.push(renderTrebleClefSVG(staffLeft + 24, baseLineY));
  } else {
    parts.push(renderBassClefSVG(staffLeft + 22, baseLineY));
  }

  // 4. Optional ghost note if the user just pressed a wrong key within visible range (-9..17)
  if (state.wrongGhostNote && !revealCorrect) {
    const ghost = state.wrongGhostNote;
    if (ghost.stepOffset >= -9 && ghost.stepOffset <= 17) {
      const ghostX = noteX + 86;
      const ghostY = stepToY(ghost.stepOffset);
      parts.push(renderLedgerLinesSVG(ghost.stepOffset, ghostX, stepToY, '#dc2626', 0.45));
      if (ghost.accidental) {
        parts.push(renderAccidentalSVG(ghost.accidental, ghostX - 28, ghostY, '#dc2626', 0.65));
      }
      parts.push(renderWholeNoteSVG(ghostX, ghostY, '#dc2626', 0.55));
      parts.push(`
        <text x="${ghostX}" y="${ghostY + 28}" text-anchor="middle" fill="#b91c1c"
              font-family="JetBrains Mono, monospace" font-size="12" font-weight="700">
          Played: ${ghost.displayName}
        </text>
      `);
    }
  }

  // 5. Ledger lines for the target note (up to 3 below or 3 above)
  const noteColor = revealCorrect ? '#15803d' : '#181715';
  parts.push(renderLedgerLinesSVG(card.stepOffset, noteX, stepToY, '#1e1d1a', 1));

  // 6. Accidental symbol (♯ or ♭) immediately to the left of the whole note
  const noteY = stepToY(card.stepOffset);
  if (card.accidental) {
    parts.push(renderAccidentalSVG(card.accidental, noteX - 32, noteY, noteColor, 1));
  }

  // 7. Engraved Whole Note (Semibreve)
  parts.push(renderWholeNoteSVG(noteX, noteY, noteColor, 1));

  // 8. Note name badge on reveal/success
  if (revealCorrect) {
    parts.push(`
      <g transform="translate(${noteX + 38}, ${noteY})">
        <rect x="0" y="-14" width="64" height="28" rx="6" fill="#15803d" />
        <text x="32" y="5" text-anchor="middle" fill="#ffffff"
              font-family="JetBrains Mono, monospace" font-size="14" font-weight="700">
          ${card.displayName}
        </text>
      </g>
    `);
  }

  svg.innerHTML = parts.join('\n');
}

/**
 * Draw ledger lines for stepOffsets <= -2 (below staff) or >= 10 (above staff).
 */
function renderLedgerLinesSVG(stepOffset, centerX, stepToY, color = '#1e1d1a', opacity = 1) {
  const lines = [];
  const halfWidth = 24;

  if (stepOffset <= -2) {
    for (let s = -2; s >= stepOffset; s -= 2) {
      const y = stepToY(s);
      lines.push(
        `<line x1="${centerX - halfWidth}" y1="${y}" x2="${centerX + halfWidth}" y2="${y}" stroke="${color}" stroke-width="2.2" stroke-linecap="round" opacity="${opacity}" />`
      );
    }
  } else if (stepOffset >= 10) {
    for (let s = 10; s <= stepOffset; s += 2) {
      const y = stepToY(s);
      lines.push(
        `<line x1="${centerX - halfWidth}" y1="${y}" x2="${centerX + halfWidth}" y2="${y}" stroke="${color}" stroke-width="2.2" stroke-linecap="round" opacity="${opacity}" />`
      );
    }
  }
  return lines.join('\n');
}

/**
 * Render an authentic engraved whole note (semibreve):
 * Outer horizontal ellipse with an angled hollow inner ellipse.
 */
function renderWholeNoteSVG(cx, cy, color = '#181715', opacity = 1) {
  const maskId = `whole-note-cutout-${Math.round(cx)}-${Math.round(cy)}`;
  return `
    <g opacity="${opacity}">
      <defs>
        <mask id="${maskId}">
          <rect x="${cx - 25}" y="${cy - 20}" width="50" height="40" fill="white" />
          <ellipse cx="${cx}" cy="${cy}" rx="7.2" ry="5.1"
                   transform="rotate(-24 ${cx} ${cy})" fill="black" />
        </mask>
      </defs>
      <ellipse cx="${cx}" cy="${cy}" rx="13.8" ry="9.2"
               fill="${color}" mask="url(#${maskId})" />
    </g>
  `;
}

/**
 * Render Sharp (♯) or Flat (♭) using crisp SVG vector geometry aligned to (x, noteY).
 */
function renderAccidentalSVG(accidental, x, noteY, color = '#181715', opacity = 1) {
  if (accidental === '♯') {
    // Sharp sign centered on (x, noteY)
    return `
      <g transform="translate(${x}, ${noteY})" opacity="${opacity}" stroke="${color}" fill="none">
        <line x1="-4.5" y1="-18" x2="-4.5" y2="19" stroke-width="2.1" stroke-linecap="round" />
        <line x1="4.5" y1="-19" x2="4.5" y2="18" stroke-width="2.1" stroke-linecap="round" />
        <line x1="-10" y1="-5" x2="10" y2="-9" stroke-width="4.2" stroke-linecap="round" />
        <line x1="-10" y1="8" x2="10" y2="4" stroke-width="4.2" stroke-linecap="round" />
      </g>
    `;
  }
  if (accidental === '♭') {
    // Flat sign with stem on the left and belly centered precisely on noteY
    return `
      <g transform="translate(${x}, ${noteY})" opacity="${opacity}">
        <line x1="-6" y1="-26" x2="-6" y2="9" stroke="${color}" stroke-width="2.3" stroke-linecap="round" />
        <path d="M -6 -3 C 2 -10, 11 -5, 9 3 C 7 9, -1 10, -6 9"
              fill="none" stroke="${color}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round" />
      </g>
    `;
  }
  return '';
}

/**
 * Render Treble Clef (G Clef) aligned so the G4 spiral centers on Line 2 (baseLineY - 20).
 */
function renderTrebleClefSVG(x, baseLineY) {
  // Staff spans y = baseLineY - 80 (Line 5 = 110) to baseLineY (Line 1 = 190).
  // Line 2 (G4) is at baseLineY - 20 = 170.
  const gLineY = baseLineY - 20;
  return `
    <g transform="translate(${x + 22}, ${gLineY})" fill="none" stroke="#1e1d1a">
      <!-- Main vertical spine from bottom hook up through top loop -->
      <path d="
        M -6 38
        C -14 38, -18 31, -13 25
        C -9 20, -2 23, -2 29
        C -2 34, -8 37, -4 38
        C 3 38, 6 30, 5 18
        L -3 -68
        C -4 -82, 6 -92, 12 -82
        C 18 -72, 12 -52, -4 -36
        C -22 -18, -28 -2, -24 12
        C -19 25, 2 28, 16 18
        C 28 9, 27 -9, 14 -16
        C 2 -22, -12 -14, -12 -2
        C -12 8, -3 13, 5 8
      " stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round" />
      <!-- Filled terminal dot at bottom hook -->
      <circle cx="-11" cy="31" r="4.2" fill="#1e1d1a" stroke="none" />
    </g>
  `;
}

/**
 * Render Bass Clef (F Clef) aligned so the F3 bulb & two dots straddle Line 4 (baseLineY - 60).
 */
function renderBassClefSVG(x, baseLineY) {
  // Line 4 (F3) is at baseLineY - 60 = 130.
  const fLineY = baseLineY - 60;
  return `
    <g transform="translate(${x + 12}, ${fLineY})">
      <!-- Terminal bulb on Line 4 -->
      <circle cx="4" cy="0" r="7.5" fill="#1e1d1a" />
      <!-- Arching C-curve of the Bass Clef -->
      <path d="
        M 2 -3
        C 2 -16, 16 -22, 27 -16
        C 39 -9, 40 10, 29 27
        C 19 42, 4 51, -8 56
      " fill="none" stroke="#1e1d1a" stroke-width="5.2" stroke-linecap="round" />
      <!-- Two dots straddling Line 4 (in Space 4 at y=-10 and Space 3 at y=+10) -->
      <circle cx="48" cy="-10" r="4.2" fill="#1e1d1a" />
      <circle cx="48" cy="10" r="4.2" fill="#1e1d1a" />
    </g>
  `;
}

/**
 * Evaluate a pressed MIDI note (from Roland FP-30X or on-screen keyboard).
 */
function handleNotePressed(midiNote, sourceLabel = 'MIDI') {
  requestScreenWakeLock();
  if (!state.currentCard || state.isTransitioning) return;

  const card = state.currentCard;
  const preferFlat = card.accidental === '♭';
  const pressedName = midiToNoteName(midiNote, preferFlat);

  state.stats.totalPresses++;

  if (midiNote === card.midi) {
    // Correct Key Pressed!
    const elapsedMs = Math.max(50, Math.round(performance.now() - state.cardStartTime));
    state.stats.correctPresses++;
    state.stats.responseTimesMs.push(elapsedMs);

    if (!state.hadErrorOnCurrentCard) {
      state.stats.streak++;
      if (state.stats.streak > state.stats.bestStreak) {
        state.stats.bestStreak = state.stats.streak;
      }
    }

    state.wrongGhostNote = null;
    state.isTransitioning = true;

    highlightPianoKey(midiNote, 'correct');
    renderFlashcard(true);
    updateStatsUI();

    const secondsStr = (elapsedMs / 1000).toFixed(2) + 's';
    const cardContainer = document.getElementById('flashcard-container');
    cardContainer.classList.remove('state-error');
    cardContainer.classList.add('state-success');

    setFeedbackBanner(
      'success',
      `Correct! ${card.displayName}`,
      `MIDI ${midiNote} • ${secondsStr} (${sourceLabel})`
    );

    state.transitionTimer = setTimeout(() => {
      cardContainer.classList.remove('state-success');
      nextFlashcard();
    }, 550);
  } else {
    // Wrong Key Pressed!
    state.hadErrorOnCurrentCard = true;
    state.stats.streak = 0;
    state.wrongGhostNote = midiToStaffPosition(midiNote, card.clef, preferFlat);

    highlightPianoKey(midiNote, 'wrong');
    renderFlashcard(false);
    updateStatsUI();

    const directionHint = midiNote < card.midi ? 'Try a higher key ↑' : 'Try a lower key ↓';
    const cardContainer = document.getElementById('flashcard-container');
    cardContainer.classList.remove('state-success', 'state-error');
    // Force reflow to restart shake animation
    void cardContainer.offsetWidth;
    cardContainer.classList.add('state-error');

    setFeedbackBanner(
      'error',
      `Incorrect — You pressed ${pressedName}`,
      `MIDI ${midiNote} • ${directionHint}`
    );
  }
}

/**
 * Update the feedback banner text and state class.
 */
function setFeedbackBanner(type, mainText, detailText) {
  const banner = document.getElementById('feedback-banner');
  const mainEl = document.getElementById('feedback-main-text');
  const detailEl = document.getElementById('feedback-detail-text');

  banner.className = `feedback-banner feedback-${type}`;
  mainEl.textContent = mainText;
  detailEl.textContent = detailText;
}

/**
 * Update Session Statistics UI counters.
 */
function updateStatsUI() {
  const { streak, bestStreak, correctPresses, totalPresses, responseTimesMs } = state.stats;

  document.getElementById('stat-streak').textContent = String(streak);
  document.getElementById('stat-best-streak').textContent = `Best: ${bestStreak}`;

  if (totalPresses === 0) {
    document.getElementById('stat-accuracy').textContent = '—';
    document.getElementById('stat-attempts').textContent = '0/0';
  } else {
    const pct = Math.round((correctPresses / totalPresses) * 100);
    document.getElementById('stat-accuracy').textContent = `${pct}%`;
    document.getElementById('stat-attempts').textContent = `${correctPresses}/${totalPresses}`;
  }

  if (responseTimesMs.length === 0) {
    document.getElementById('stat-avg-time').textContent = '—';
    document.getElementById('stat-last-time').textContent = 'Last: —';
  } else {
    const sum = responseTimesMs.reduce((a, b) => a + b, 0);
    const avgSec = (sum / responseTimesMs.length / 1000).toFixed(2);
    const lastSec = (responseTimesMs[responseTimesMs.length - 1] / 1000).toFixed(2);
    document.getElementById('stat-avg-time').textContent = `${avgSec}s`;
    document.getElementById('stat-last-time').textContent = `Last: ${lastSec}s`;
  }
}

function resetStats() {
  state.stats.streak = 0;
  state.stats.bestStreak = 0;
  state.stats.correctPresses = 0;
  state.stats.totalPresses = 0;
  state.stats.responseTimesMs = [];
  updateStatsUI();
}

/**
 * Build the 88-key interactive piano visualizer (A0 = MIDI 21 to C8 = MIDI 108).
 */
function buildPianoKeyboard() {
  const container = document.getElementById('piano-keyboard');
  if (!container) return;
  container.innerHTML = '';

  const blackSemitones = new Set([1, 3, 6, 8, 10]);
  const whiteKeys = [];

  // First pass: create all 52 white keys
  for (let midi = 21; midi <= 108; midi++) {
    const semitone = midi % 12;
    if (!blackSemitones.has(semitone)) {
      const keyEl = document.createElement('div');
      keyEl.className = 'white-key';
      if (midi === 60) keyEl.classList.add('middle-c');
      keyEl.dataset.midi = String(midi);
      keyEl.title = `${midiToNoteName(midi)} (MIDI ${midi})`;

      const octave = Math.floor(midi / 12) - 1;
      // Label all 'C' keys (C1..C8) and F3/G2 landmarks for easy orientation
      if (semitone === 0 || midi === 21) {
        const label = document.createElement('span');
        label.className = 'key-label';
        label.textContent = midiToNoteName(midi);
        keyEl.appendChild(label);
      }

      keyEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handleNotePressed(midi, 'On-Screen Key');
      });

      container.appendChild(keyEl);
      whiteKeys.push({ midi, element: keyEl });
    }
  }

  // Second pass: position the 36 black keys accurately between adjacent white keys
  const totalWhite = whiteKeys.length; // 52 white keys
  const blackKeyWidthPct = (100 / totalWhite) * 0.64;

  let whiteIndex = 0;
  for (let midi = 21; midi <= 108; midi++) {
    const semitone = midi % 12;
    if (!blackSemitones.has(semitone)) {
      whiteIndex++;
    } else {
      const blackEl = document.createElement('div');
      blackEl.className = 'black-key';
      blackEl.dataset.midi = String(midi);
      blackEl.title = `${midiToNoteName(midi)} / ${midiToNoteName(midi, true)} (MIDI ${midi})`;

      const leftPct = (whiteIndex / totalWhite) * 100 - blackKeyWidthPct / 2;
      blackEl.style.left = `${leftPct}%`;
      blackEl.style.width = `${blackKeyWidthPct}%`;

      blackEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleNotePressed(midi, 'On-Screen Key');
      });

      container.appendChild(blackEl);
    }
  }
}

function highlightPianoKey(midi, status) {
  const keyEl = document.querySelector(`[data-midi="${midi}"]`);
  if (!keyEl) return;

  if (status === 'correct') {
    clearPianoKeyHighlights();
    keyEl.classList.add('key-correct', 'key-active');
  } else if (status === 'wrong') {
    keyEl.classList.add('key-wrong', 'key-active');
    setTimeout(() => {
      keyEl.classList.remove('key-active');
    }, 220);
  }
}

function clearPianoKeyHighlights() {
  document.querySelectorAll('.key-correct, .key-wrong, .key-active').forEach((el) => {
    el.classList.remove('key-correct', 'key-wrong', 'key-active');
  });
}

function updatePianoRangeIndicators() {
  document.querySelectorAll('.white-key.key-in-range').forEach((el) => {
    el.classList.remove('key-in-range');
  });
  if (!state.currentCard) return;

  const { minMidi, maxMidi } = getClefStepBounds(
    state.currentCard.clef,
    state.ledgerLines
  );

  const inRangeEls = [];
  document.querySelectorAll('.white-key').forEach((el) => {
    const m = Number(el.dataset.midi);
    if (m >= minMidi && m <= maxMidi) {
      el.classList.add('key-in-range');
      inRangeEls.push(el);
    }
  });

  // Auto-scroll horizontal piano wrapper on phones/tablets so the active clef range is centered
  const wrapper = document.getElementById('piano-scroll-wrapper');
  if (wrapper && inRangeEls.length > 0 && wrapper.scrollWidth > wrapper.clientWidth) {
    const firstEl = inRangeEls[0];
    const lastEl = inRangeEls[inRangeEls.length - 1];
    const rangeCenter =
      (firstEl.offsetLeft + lastEl.offsetLeft + lastEl.offsetWidth) / 2;
    const targetScroll = Math.max(0, rangeCenter - wrapper.clientWidth / 2);
    wrapper.scrollLeft = targetScroll;
  }
}

/**
 * Web MIDI API Integration for Roland FP-30X
 */
async function initWebMIDI() {
  const badge = document.getElementById('midi-status-badge');
  const statusText = document.getElementById('midi-status-text');
  const selectEl = document.getElementById('midi-device-select');

  if (!navigator.requestMIDIAccess) {
    badge.dataset.status = 'error';
    statusText.textContent = 'Web MIDI API not supported in this browser (use Chrome or Edge)';
    return;
  }

  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    state.midiAccess = access;

    access.onstatechange = () => {
      refreshMIDIInputs();
    };

    refreshMIDIInputs();
  } catch (err) {
    badge.dataset.status = 'error';
    statusText.textContent = 'MIDI permission blocked or unavailable (check browser permission)';
    selectEl.innerHTML = '<option value="none">MIDI Access Denied</option>';
  }
}

function refreshMIDIInputs() {
  const access = state.midiAccess;
  if (!access) return;

  const badge = document.getElementById('midi-status-badge');
  const statusText = document.getElementById('midi-status-text');
  const selectEl = document.getElementById('midi-device-select');

  const inputs = Array.from(access.inputs.values());
  state.activeInputs = inputs;

  // Clear previous listeners and attach fresh listeners
  inputs.forEach((input) => {
    input.onmidimessage = (event) => onMIDIMessage(event, input);
  });

  // Populate device selector dropdown
  selectEl.innerHTML = '';
  if (inputs.length === 0) {
    badge.dataset.status = 'disconnected';
    statusText.textContent = 'Waiting for Roland FP-30X (connect via USB or Bluetooth MIDI)';
    const opt = document.createElement('option');
    opt.value = 'none';
    opt.textContent = 'No MIDI devices detected';
    selectEl.appendChild(opt);
    return;
  }

  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = `All MIDI Inputs (${inputs.length})`;
  selectEl.appendChild(allOpt);

  let rolandId = null;
  inputs.forEach((input) => {
    const opt = document.createElement('option');
    opt.value = input.id;
    opt.textContent = input.name || `MIDI Input (${input.id})`;
    selectEl.appendChild(opt);

    if (/roland|fp-?30/i.test(input.name || '')) {
      rolandId = input.id;
    }
  });

  // Auto-select Roland FP-30X if detected and user hasn't manually chosen another existing port
  if (rolandId && (state.selectedInputId === 'all' || !inputs.some((i) => i.id === state.selectedInputId))) {
    state.selectedInputId = rolandId;
  } else if (!inputs.some((i) => i.id === state.selectedInputId)) {
    state.selectedInputId = 'all';
  }

  selectEl.value = state.selectedInputId;

  const chosenInput = inputs.find((i) => i.id === state.selectedInputId) || inputs[0];
  badge.dataset.status = 'connected';
  statusText.textContent = `Connected: ${chosenInput.name || 'MIDI Keyboard'}`;
}

function onMIDIMessage(event, inputPort) {
  if (state.selectedInputId !== 'all' && inputPort.id !== state.selectedInputId) {
    return;
  }

  const data = event.data;
  if (!data || data.length < 2) return;

  // Ignore MIDI Active Sensing (0xFE) and System Real-Time messages (0xF8..0xFF)
  // which Roland FP-30X transmits continuously.
  if (data[0] >= 0xf0) return;

  const command = data[0] & 0xf0;
  const note = data[1];
  const velocity = data.length > 2 ? data[2] : 0;

  // Pulse MIDI indicator dot on any note message
  const dot = document.getElementById('midi-dot');
  if (dot) {
    dot.classList.add('pulse-active');
    setTimeout(() => dot.classList.remove('pulse-active'), 120);
  }

  // Note On with velocity > 0 is a key press (velocity === 0 is Note Off)
  if (command === 0x90 && velocity > 0) {
    handleNotePressed(note, inputPort.name || 'Roland FP-30X');
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    const keyEl = document.querySelector(`[data-midi="${note}"]`);
    if (keyEl) keyEl.classList.remove('key-active');
  }
}

/**
 * Direct Web Bluetooth LE MIDI connection (bypasses macOS System Settings > Bluetooth
 * which only shows Bluetooth Audio, and connects directly to BLE MIDI service).
 */
const BLE_MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const BLE_MIDI_CHAR_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';

async function connectBluetoothMIDI() {
  const badge = document.getElementById('midi-status-badge');
  const statusText = document.getElementById('midi-status-text');
  const selectEl = document.getElementById('midi-device-select');

  if (!navigator.bluetooth) {
    badge.dataset.status = 'error';
    statusText.textContent = 'Web Bluetooth not available in this browser (use Chrome or Edge)';
    return;
  }

  try {
    statusText.textContent = 'Select FP-30X MIDI in browser popup…';
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [BLE_MIDI_SERVICE_UUID] },
        { namePrefix: 'FP-' },
        { namePrefix: 'Roland' }
      ],
      optionalServices: [BLE_MIDI_SERVICE_UUID]
    });

    statusText.textContent = `Connecting to ${device.name || 'BLE MIDI'}…`;

    // Android BLE stack often throws a transient GATT error if connect() is called
    // immediately while the scan chooser is still closing; retry up to 3 times.
    let characteristic = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, 250 * attempt));
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_MIDI_SERVICE_UUID);
        characteristic = await service.getCharacteristic(BLE_MIDI_CHAR_UUID);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!characteristic) {
      throw lastErr || new Error('GATT connection failed');
    }

    await characteristic.startNotifications();
    const blePort = {
      id: `ble-${device.id || 'fp30x'}`,
      name: `${device.name || 'Roland FP-30X'} (BLE MIDI)`
    };

    characteristic.addEventListener('characteristicvaluechanged', (event) => {
      const dv = event.target.value;
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      parseBLEMIDIPacket(bytes, blePort);
    });

    device.addEventListener('gattserverdisconnected', () => {
      badge.dataset.status = 'disconnected';
      statusText.textContent = 'Bluetooth MIDI disconnected — click Pair Bluetooth MIDI to reconnect';
    });

    // Update UI dropdown and status
    state.selectedInputId = 'all';
    badge.dataset.status = 'connected';
    statusText.textContent = `Connected: ${blePort.name}`;

    const opt = document.createElement('option');
    opt.value = 'all';
    opt.textContent = blePort.name;
    selectEl.innerHTML = '';
    selectEl.appendChild(opt);
    selectEl.value = 'all';
  } catch (err) {
    if (err && err.name === 'NotFoundError') {
      // User closed the chooser dialog
      refreshMIDIInputs();
      return;
    }
    badge.dataset.status = 'error';
    statusText.textContent = `Bluetooth MIDI error: ${err.message || err}`;
  }
}

/**
 * Parse a standard BLE MIDI packet (Header byte + [Timestamp, Status, Data1, Data2]...).
 */
function parseBLEMIDIPacket(bytes, blePort) {
  if (!bytes || bytes.length < 3) return;

  let currentStatus = 0;
  let i = 1; // Skip byte 0 (BLE MIDI header byte)

  while (i < bytes.length) {
    const b = bytes[i];

    if (b >= 0x80) {
      // Timestamp byte (bit 7 = 1). Check if followed by a MIDI status byte:
      if (i + 1 < bytes.length && bytes[i + 1] >= 0x80) {
        const statusCandidate = bytes[i + 1];
        // Ignore System Real-Time (0xF8..0xFF) like Active Sensing (0xFE)
        if (statusCandidate >= 0xf8) {
          i += 2;
          continue;
        }
        currentStatus = statusCandidate;
        i += 2;
      } else {
        // Timestamp byte preceding running-status data bytes
        i += 1;
      }
      continue;
    }

    // Data byte (< 0x80)
    const cmd = currentStatus & 0xf0;
    if ((cmd === 0x90 || cmd === 0x80 || cmd === 0xb0 || cmd === 0xe0) && i + 1 < bytes.length && bytes[i + 1] < 0x80) {
      const data1 = bytes[i];
      const data2 = bytes[i + 1];
      if (cmd === 0x90 || cmd === 0x80) {
        onMIDIMessage({ data: [currentStatus, data1, data2] }, blePort);
      }
      i += 2;
    } else {
      // 1-byte message (0xC0, 0xD0) or unknown
      i += 1;
    }
  }
}

/**
 * Screen Wake Lock API: prevents phone/tablet/laptop screen from dimming or
 * turning off while practicing on the MIDI piano (since MIDI messages do not
 * count as OS touch/keyboard activity).
 */
async function requestScreenWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') {
    return;
  }
  if (state.wakeLockSentinel && !state.wakeLockSentinel.released) {
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    state.wakeLockSentinel = sentinel;
    sentinel.addEventListener('release', () => {
      if (state.wakeLockSentinel === sentinel) {
        state.wakeLockSentinel = null;
      }
    });
  } catch (_) {
    // Ignore if blocked by low-power mode or awaiting initial user gesture
  }
}

function initScreenWakeLock() {
  requestScreenWakeLock();

  // Browsers automatically release screen wake locks when a tab is backgrounded
  // or the screen is locked; re-acquire immediately when visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestScreenWakeLock();
    }
  });

  // Also ensure wake lock is acquired on any touch, click, or key interaction
  document.addEventListener('pointerdown', () => requestScreenWakeLock(), { passive: true });
  document.addEventListener('keydown', () => requestScreenWakeLock(), { passive: true });
}

/**
 * Wire up UI event listeners on DOMContentLoaded.
 */
document.addEventListener('DOMContentLoaded', () => {
  initScreenWakeLock();
  buildPianoKeyboard();
  updateStatsUI();

  // Clef mode segmented buttons ('treble', 'bass', 'both')
  document.querySelectorAll('.segment-btn[data-clef]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segment-btn[data-clef]').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      state.clefMode = btn.dataset.clef;
      nextFlashcard();
    });
  });

  // Ledger lines dropdown ('0' .. '4')
  const ledgerSelect = document.getElementById('select-ledger-lines');
  if (ledgerSelect) {
    state.ledgerLines = Number(ledgerSelect.value) || 0;
    ledgerSelect.addEventListener('change', (e) => {
      state.ledgerLines = Number(e.target.value) || 0;
      nextFlashcard();
    });
  }

  // Include Sharps & Flats checkbox
  const accidentalsCheckbox = document.getElementById('toggle-accidentals');
  accidentalsCheckbox.addEventListener('change', (e) => {
    state.includeAccidentals = e.target.checked;
    nextFlashcard();
  });

  // MIDI device selector dropdown
  const midiSelect = document.getElementById('midi-device-select');
  midiSelect.addEventListener('change', (e) => {
    state.selectedInputId = e.target.value;
    refreshMIDIInputs();
  });

  // Direct Web Bluetooth MIDI pairing button
  const bleBtn = document.getElementById('btn-ble-midi');
  if (bleBtn) {
    bleBtn.addEventListener('click', () => {
      connectBluetoothMIDI();
    });
  }

  // Rescan / Connect MIDI button
  document.getElementById('btn-rescan-midi').addEventListener('click', () => {
    initWebMIDI();
  });

  // Download self-contained HTML file for offline/laptop use
  const downloadBtn = document.getElementById('btn-download-html');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      let htmlContent = '';
      try {
        const resp = await fetch('roland-fp30x-standalone.html');
        if (resp.ok) {
          htmlContent = await resp.text();
        }
      } catch (_) {
        // Ignore fetch error if running inside a standalone file or sandbox
      }
      if (!htmlContent) {
        htmlContent = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      }
      const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'roland-fp30x-flashcards.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  // Skip Note & Reset Stats buttons
  document.getElementById('btn-skip-note').addEventListener('click', () => {
    nextFlashcard();
  });

  document.getElementById('btn-reset-stats').addEventListener('click', () => {
    resetStats();
  });

  // Toggle 88-Key Piano Monitor visibility
  const togglePianoBtn = document.getElementById('btn-toggle-piano');
  const pianoSection = document.getElementById('piano-section');
  if (togglePianoBtn && pianoSection) {
    // On short landscape phone screens (e.g. Pixel 9 landscape 915x412), collapse
    // the 88-key monitor initially so the entire flashcard trainer fits without scrolling.
    if (window.innerHeight <= 540 && window.innerWidth > window.innerHeight) {
      pianoSection.classList.add('piano-collapsed');
      togglePianoBtn.textContent = 'Show Keys';
      togglePianoBtn.setAttribute('aria-expanded', 'false');
    }

    togglePianoBtn.addEventListener('click', () => {
      const collapsed = pianoSection.classList.toggle('piano-collapsed');
      togglePianoBtn.textContent = collapsed ? 'Show Keys' : 'Hide Keys';
      togglePianoBtn.setAttribute('aria-expanded', String(!collapsed));
      if (!collapsed) {
        updatePianoRangeIndicators();
      }
    });
  }

  window.addEventListener('resize', () => {
    updatePianoRangeIndicators();
  });

  // Start first flashcard & initialize Web MIDI
  nextFlashcard();
  initWebMIDI();
});
