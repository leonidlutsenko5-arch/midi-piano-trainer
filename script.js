// === MIDI ТРЕНАЖЕР ДЛЯ ПІАНІНО ===
// Усі тайминги зберігаються в "транспортних" секундах (Tone.Transport.seconds).

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_COLORS = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#9B59B6', '#8B4513', '#FF6B9D',
    '#A3D39C', '#FFD93D', '#6BCF7F', '#4A90E2', '#F39C12', '#E74C3C'];
const FIRST_MIDI = 21;          // A0
const LAST_MIDI = 108;          // C8 (повна клавіатура піаніно)
const CONTAINER_H = 600;        // висота зони падіння, px
const LEAD_BEATS = 2;           // скільки ударів нота падає до клавіші
const WINDOW = 0.3;             // вікно попадання, с (±)
const GRADE_PERFECT = 0.06;     // межа "ідеально", с
const GRADE_GOOD = 0.12;        // межа "добре", с
const POINTS = { perfect: 100, good: 70, ok: 40 };
const CAL_BEATS = 8;
const CAL_PERIOD = 0.6;
const PC_KEY_MAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12 };
const STATS_KEY = 'midiTrainerStats';

const nameToMidi = (name) => {
    const m = name.match(/^([A-G]#?)(-?\d)$/);
    if (!m) return null;
    const map = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
    return 12 * (parseInt(m[2], 10) + 1) + map[m[1]];
};
const midiToName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
const isBlackMidi = (m) => NOTE_NAMES[m % 12].includes('#');
const SOLFEGE = ['до', 'до♯', 'ре', 'ре♯', 'мі', 'фа', 'фа♯', 'соль', 'соль♯', 'ля', 'ля♯', 'сі'];
// Назва ноти для підпису: solfege (до ре мі; октава лише для до), letters (C4, C#4), off (порожньо)
const noteLabel = (m, mode) => {
    if (mode === 'solfege') {
        const name = SOLFEGE[m % 12];
        return NOTE_NAMES[m % 12] === 'C' ? `${name}${Math.floor(m / 12) - 1}` : name;
    }
    if (mode === 'letters') return midiToName(m);
    return '';
};

const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const fmtTime = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// === СТАТИСТИКА ===
const defaultStats = () => ({ bestScore: 0, avgAccuracy: 0, totalPlays: 0, avgDeviationMs: 0, records: [] });

function loadStats() {
    try {
        const s = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
        if (!s || typeof s !== 'object' || Array.isArray(s)) return defaultStats();
        const num = (v) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
        return {
            bestScore: num(s.bestScore),
            avgAccuracy: num(s.avgAccuracy),
            totalPlays: num(s.totalPlays),
            avgDeviationMs: num(s.avgDeviationMs),
            records: Array.isArray(s.records) ? s.records.slice(-100) : []
        };
    } catch (error) {
        console.warn('Не вдалося завантажити статистику:', error);
        return defaultStats();
    }
}

function saveStats() {
    try {
        localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (error) {
        console.warn('Не вдалося зберегти статистику:', error);
    }
}

let stats = loadStats();

// === ЗАВАНТАЖЕННЯ НОТ ===
// Кожен формат перетворюється у той самий об'єкт { header, tracks }:
//   MIDI (.mid, .midi, .kar) — напряму через @tonejs/midi;
//   ABC (.abc) — abcjs конвертує в MIDI;
//   MusicXML (.xml, .musicxml) і .mxl — musicxml.js розбирає партитуру.
async function loadSong(file) {
    const name = file.name.toLowerCase();

    if (name.endsWith('.abc')) {
        if (!window.ABCJS) throw new Error('abcjs не завантажено');
        const out = window.ABCJS.synth.getMidiFile(await file.text(), { midiOutputType: 'binary' });
        if (!out || !out[0]) throw new Error('У файлі ABC не знайдено нот');
        return new window.Midi(Uint8Array.from(Object.values(out[0])).buffer);
    }

    if (name.endsWith('.mxl')) {
        if (!window.MusicXML) throw new Error('musicxml.js не завантажено');
        const xml = await window.MusicXML.readMxlText(await file.arrayBuffer());
        return window.MusicXML.parseMusicXML(xml);
    }

    if (name.endsWith('.xml') || name.endsWith('.musicxml')) {
        if (!window.MusicXML) throw new Error('musicxml.js не завантажено');
        return window.MusicXML.parseMusicXML(await file.text());
    }

    return new window.Midi(await file.arrayBuffer());
}

document.addEventListener('DOMContentLoaded', () => {
    // === ЕЛЕМЕНТИ ===
    const E = {};
    [
        'startButton', 'midiFileInput', 'trackSelect', 'partSelect', 'splitInput', 'splitLabel',
        'accompanimentCheck', 'noteLabelSelect', 'tempoModeSelect', 'bpmInput', 'speedSlider', 'speedDisplay',
        'loopCheck', 'loopFrom', 'loopTo', 'latencyInput', 'calibrateBtn', 'instrumentSelect',
        'volumeSlider', 'scoreDisplay', 'missDisplay', 'extraDisplay', 'timeDisplay', 'tempoDisplay',
        'feedbackDisplay', 'resultsPanel', 'statsDisplay', 'playBtn', 'pauseBtn', 'stopBtn',
        'recBtn', 'saveMidiBtn', 'stopAllBtn', 'fallingNotesContainer', 'keyboard', 'audioHint'
    ].forEach((id) => { E[id] = document.getElementById(id); });

    const keyboardEl = E.keyboard;
    const fallEl = E.fallingNotesContainer;

    // Синхронізація горизонтального скролу клавіатури і зони падіння
    let syncingScroll = false;
    const syncScroll = (from, to) => () => {
        if (syncingScroll) return;
        syncingScroll = true;
        to.scrollLeft = from.scrollLeft;
        syncingScroll = false;
    };
    keyboardEl.addEventListener('scroll', syncScroll(keyboardEl, fallEl));
    fallEl.addEventListener('scroll', syncScroll(fallEl, keyboardEl));

    // === СТАН ===
    let synth = null;
    let beepSynth = null;
    let midiData = null;
    let allNotes = [];          // [{midi, time, duration, velocity, track}] відсортовано за часом
    let session = null;         // поточна/остання сесія відтворення чи тренування
    let isRecording = false;
    let recordedEvents = [];
    let rafId = null;
    let midiOutputs = [];
    const userNotes = new Map();   // midi -> {el, start}
    const pcKeys = new Map();      // символ клавіатури -> midi
    let octaveShift = 0;
    let calibration = null;        // {clicks, offsets, timer}
    let loopTimer = null;
    let feedbackTimer = null;

    // === ПАРАМЕТРИ З ІНТЕРФЕЙСУ ===
    const getFileBpm = () => midiData?.header?.tempos?.[0]?.bpm || 120;
    const getPlaybackBpm = () => (E.tempoModeSelect.value === 'custom'
        ? (parseFloat(E.bpmInput.value) || getFileBpm())
        : getFileBpm());
    const getSpeed = () => parseFloat(E.speedSlider.value) || 1;
    const getLatency = () => Math.max(0, parseFloat(E.latencyInput.value) || 0) / 1000;
    const getKeyEl = (midi) => keyboardEl.querySelector(`.key[data-midi="${midi}"]`);
    const getMode = () => document.querySelector('input[name="mode"]:checked').value;

    // === АУДІО ===
    function setupSynth() {
        if (synth) {
            synth.releaseAll();
            synth.dispose();
        }
        let newSynth;
        switch (E.instrumentSelect.value) {
            case 'piano':
                newSynth = new Tone.PolySynth(Tone.Synth, {
                    oscillator: { type: 'triangle' },
                    envelope: { attack: 0.003, decay: 0.45, sustain: 0.08, release: 0.6 }
                });
                break;
            case 'organ':
                newSynth = new Tone.PolySynth(Tone.FMSynth, {
                    harmonicity: 3.01,
                    modulationIndex: 14,
                    oscillator: { type: 'sine' },
                    envelope: { attack: 0.01, decay: 0.1, sustain: 1, release: 0.5 }
                });
                break;
            default:
                newSynth = new Tone.PolySynth(Tone.Synth, {
                    oscillator: { type: 'fatsawtooth', count: 3, spread: 18 },
                    envelope: { attack: 0.02, decay: 0.25, sustain: 0.25, release: 0.45 }
                });
        }
        synth = newSynth.toDestination();
        setSynthVolume();
    }

    function setSynthVolume() {
        if (!synth) return;
        const v = Math.min(1, Math.max(0, Number(E.volumeSlider.value)));
        synth.volume.value = v === 0 ? -Infinity : 20 * Math.log10(v);
    }

    function beepSound(note, duration = 0.1) {
        if (!beepSynth) beepSynth = new Tone.Synth().toDestination();
        beepSynth.triggerAttackRelease(note, duration);
    }

    async function initAudio() {
        try {
            await Tone.start();
            setupSynth();
            if (!beepSynth) beepSynth = new Tone.Synth().toDestination();
            E.startButton.disabled = true;
            E.startButton.textContent = 'Аудіо розблоковано';
            beepSound('C4', 0.1);
            E.audioHint.style.display = 'none';

            if (navigator.requestMIDIAccess) {
                try {
                    onMIDISuccess(await navigator.requestMIDIAccess({ sysex: false }));
                } catch (err) {
                    console.warn('Не вдалося отримати доступ до MIDI:', err);
                    alert('⚠️ MIDI-клавіатура не підключена або заборонена. Клавіатура екрана та клавіші A–K працюють без неї.');
                }
            }
        } catch (err) {
            console.error('Не вдалося розблокувати аудіо:', err);
            alert('Не вдалося розблокувати аудіо. Переконайтесь, що ви клікнули на кнопку.');
        }
    }

    // === КЛАВІАТУРА ===
    function buildKeyboard() {
        keyboardEl.innerHTML = '';
        const W = 40;
        const whites = [];
        for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) if (!isBlackMidi(m)) whites.push(m);
        const total = whites.length * W;
        keyboardEl.style.width = total + 'px';
        fallEl.style.width = total + 'px';

        const posOf = {};
        whites.forEach((m, i) => { posOf[m] = i * W; });

        for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
            const key = document.createElement('div');
            const black = isBlackMidi(m);
            key.className = 'key ' + (black ? 'black-key' : 'white-key');
            key.dataset.midi = String(m);
            key.dataset.note = midiToName(m);
            const lab = document.createElement('span');
            lab.className = 'key-label';
            key.appendChild(lab);
            key.style.left = (black ? posOf[m - 1] + W * 0.7 : posOf[m]) + 'px';
            key.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                Tone.start();
                onNoteOn(m, 0.9);
            });
            key.addEventListener('pointerup', () => onNoteOff(m));
            key.addEventListener('pointerleave', () => onNoteOff(m));
            keyboardEl.appendChild(key);
        }
    }

    function highlightOn(name) {
        keyboardEl.querySelector(`.key[data-note="${name}"]`)?.classList.add('active');
    }

    function highlightOff(name) {
        keyboardEl.querySelector(`.key[data-note="${name}"]`)?.classList.remove('active');
    }

    // Підписи на клавішах, падаючих нотах і нотах, які граєш
    function refreshNoteLabels() {
        const mode = E.noteLabelSelect.value;
        keyboardEl.querySelectorAll('.key').forEach((k) => {
            k.querySelector('.key-label').textContent = noteLabel(Number(k.dataset.midi), mode);
        });
        fallEl.querySelectorAll('.note-fall, .user-note').forEach((el) => {
            el.textContent = noteLabel(Number(el.dataset.midi), mode);
        });
    }

    // === ВІЗУАЛІЗАЦІЯ ===
    function makeNoteEl(it) {
        const keyEl = getKeyEl(it.midi);
        if (!keyEl) return null;
        const d = document.createElement('div');
        d.className = 'note-fall' + (it.expect ? ' expect' : ' dim');
        d.dataset.midi = String(it.midi);
        d.textContent = noteLabel(it.midi, E.noteLabelSelect.value);
        d.style.left = keyEl.offsetLeft + 'px';
        d.style.width = keyEl.offsetWidth + 'px';
        d.style.height = it.h + 'px';
        d.style.background = NOTE_COLORS[it.midi % 12];
        if (it.status === 'hit') d.classList.add('hit');
        if (it.status === 'miss') d.classList.add('miss');
        fallEl.appendChild(d);
        return d;
    }

    function paintNote(it, cls) {
        if (it.el) it.el.classList.add(cls);
    }

    function spawnUserNote(midi) {
        const keyEl = getKeyEl(midi);
        if (!keyEl) return;
        const d = document.createElement('div');
        d.className = 'user-note';
        d.dataset.midi = String(midi);
        d.textContent = noteLabel(midi, E.noteLabelSelect.value);
        d.style.left = keyEl.offsetLeft + 'px';
        d.style.width = keyEl.offsetWidth + 'px';
        d.style.background = NOTE_COLORS[midi % 12];
        fallEl.appendChild(d);
        userNotes.set(midi, { el: d, start: performance.now() });
    }

    function releaseUserNote(midi) {
        const u = userNotes.get(midi);
        if (!u) return;
        userNotes.delete(midi);
        u.el.style.transition = 'bottom 1.6s linear, opacity 0.6s';
        requestAnimationFrame(() => {
            u.el.style.bottom = CONTAINER_H + 'px';
            u.el.style.opacity = '0';
        });
        setTimeout(() => u.el.remove(), 2000);
    }

    function flashFeedback(text, cls) {
        E.feedbackDisplay.textContent = text;
        E.feedbackDisplay.className = 'feedback ' + (cls || '');
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => { E.feedbackDisplay.textContent = ''; }, 1500);
    }

    // === ПОБУДОВА СЕСІЇ ===
    function inSelection(n, split) {
        const track = E.trackSelect.value;
        if (track !== 'all' && Number(track) !== n.track) return false;
        const part = E.partSelect.value;
        if (part === 'high') return n.midi >= split;
        if (part === 'low') return n.midi < split;
        return true;
    }

    function buildSession(mode) {
        const fileBpm = getFileBpm();
        const bpm = getPlaybackBpm();
        const speed = getSpeed();
        // секунди з файлу -> транспортні секунди (з урахуванням темпу і швидкості)
        const scale = (fileBpm / bpm) / speed;
        const lead = (LEAD_BEATS * 60) / (bpm * speed);

        const from = Math.max(0, parseFloat(E.loopFrom.value) || 0);
        const toVal = parseFloat(E.loopTo.value);
        const to = Number.isFinite(toVal) && toVal > from ? toVal : Infinity;
        const split = Math.min(LAST_MIDI, Math.max(FIRST_MIDI, parseInt(E.splitInput.value, 10) || 60));

        const notes = allNotes.filter((n) => n.time >= from && n.time < to);
        if (!notes.length) return null;

        let endT = 0;
        const items = notes.map((n) => {
            const t = (n.time - from) * scale + lead;
            const d = Math.max(0.05, n.duration * scale);
            endT = Math.max(endT, t + d);
            return {
                midi: n.midi,
                name: midiToName(n.midi),
                f: n.time,            // початок у файлі, с
                fd: n.duration,       // тривалість у файлі, с
                t,
                d,
                vel: n.velocity ?? 0.8,
                h: Math.max(14, d * CONTAINER_H / lead),
                track: n.track,
                on: false,
                sel: inSelection(n, split),
                expect: mode === 'practice' && inSelection(n, split),
                status: 'pending',   // pending | hit | miss
                err: 0,
                points: 0,
                grade: null,
                userT: null,
                el: null
            };
        });

        return {
            mode, items, lead, bpm, speed, scale, from, fileBpm,
            endT: endT + WINDOW + 0.5,
            state: 'playing',
            score: 0,
            missed: 0,
            extra: 0
        };
    }

    // === ЗВУК: власний планувальник ===
    // Ноти запускаються і відпускаються напряму (без подій Transport і без таймерів Tone),
    // тому пауза, зміна швидкості чи вибору не можуть залишити ноту без відпускання.
    // Прапорець on = нота зараз звучить.
    function audioTick() {
        const s = session;
        if (!s || s.state !== 'playing' || !synth) return;
        const now = Tone.Transport.seconds;
        for (const it of s.items) {
            const aud = isAudible(it, s.mode);
            if (it.on && (!aud || now >= it.t + it.d)) {
                synth.triggerRelease(it.name);
                it.on = false;
            }
            if (!it.on && aud && now >= it.t && now < it.t + it.d) {
                synth.triggerAttack(it.name, undefined, it.vel);
                it.on = true;
            }
        }
    }

    // Відтворення: звучать вибрані руки/доріжки. Тренування: звучать решта (як акомпанемент).
    // Галочка "Грати не вибрані ноти" додає до звуку ті, що не вибрані, у відтворенні.
    function isAudible(it, mode) {
        const accomp = E.accompanimentCheck.checked;
        return mode === 'playback' ? (it.sel || accomp) : (!it.sel && accomp);
    }

    // === ЦИКЛ ОНОВЛЕННЯ (падіння нот, таймер, пропуски) ===
    function tick() {
        rafId = requestAnimationFrame(tick);
        const now = Tone.Transport.seconds;

        if (session && session.state !== 'done') {
            const s = session;
            E.timeDisplay.textContent = fmtTime(now - s.lead);

            for (const it of s.items) {
                if (!it.el && now >= it.t - s.lead - 0.05 && now <= it.t + it.d + 0.5) {
                    it.el = makeNoteEl(it);
                }
                if (it.el) {
                    const progress = (now - (it.t - s.lead)) / s.lead;
                    it.el.style.top = (progress * CONTAINER_H - it.h) + 'px';
                    if (now > it.t + it.d + 0.5) {
                        it.el.remove();
                        it.el = null;
                    }
                }
            }

            if (s.mode === 'practice' && s.state === 'playing') {
                for (const it of s.items) {
                    if (it.expect && it.status === 'pending' && now > it.t + WINDOW) {
                        it.status = 'miss';
                        s.missed++;
                        paintNote(it, 'miss');
                        updateLive();
                    }
                }
            }

            if (s.state === 'playing' && now >= s.endT) finishSession('end');
        }

        for (const u of userNotes.values()) {
            u.el.style.height = Math.max(20, (performance.now() - u.start) / 1000 * 120) + 'px';
        }
    }

    // === СЕСІЯ: СТАРТ / ПАУЗА / СТОП ===
    function startSession({ clearResults = true } = {}) {
        if (!midiData) return alert('Спочатку завантажте MIDI-файл');
        if (!synth) return alert('Спочатку натисніть "Start (розблокувати аудіо)"');

        const mode = getMode();
        clearTimeout(loopTimer);
        if (session && session.state !== 'done') finishSession('stop');

        const s = buildSession(mode);
        if (!s) return alert('У вибраному фрагменті немає нот');
        if (mode === 'practice' && !s.items.some((i) => i.expect)) {
            return alert('У вибраній частині немає нот для тренування');
        }

        session = s;
        Tone.Transport.stop();
        Tone.Transport.cancel();
        if (clearResults) E.resultsPanel.innerHTML = '';
        Tone.Transport.start();
        updateLive();
        updateButtons();
    }

    function pauseSession() {
        if (!session || session.state !== 'playing') return;
        Tone.Transport.pause();
        session.state = 'paused';
        synth?.releaseAll();
        updateButtons();
    }

    function resumeSession() {
        if (!session || session.state !== 'paused') return;
        session.state = 'playing';
        Tone.Transport.start();
        updateButtons();
    }

    // Зміна вибору рук/доріжки під час гри: оновлюємо тільки ще не зіграні ноти
    function applySelectionChange() {
        const s = session;
        if (!s || s.state === 'done') return;
        const now = Tone.Transport.seconds;
        const split = Math.min(LAST_MIDI, Math.max(FIRST_MIDI, parseInt(E.splitInput.value, 10) || 60));
        for (const it of s.items) {
            if (it.t <= now) continue;
            it.sel = inSelection({ midi: it.midi, track: it.track }, split);
            it.expect = s.mode === 'practice' && it.sel;
            if (it.el) {
                it.el.classList.toggle('expect', it.expect);
                it.el.classList.toggle('dim', !it.expect);
            }
        }

    }

    // Зміна швидкості без зупинки: переносимо поточну позицію у файлі на нову шкалу часу,
    // перераховуємо ноти і перепланьовуємо звук. Статуси вже оцінених нот зберігаються.
    function applySpeedChange() {
        const s = session;
        if (!s || s.state === 'done') return;
        const newSpeed = getSpeed();
        if (Math.abs(newSpeed - s.speed) < 1e-9) return;

        const now = Tone.Transport.seconds;
        const fileNow = s.from + (now - s.lead) / s.scale;      // позиція у файлі, с
        const scale = (s.fileBpm / s.bpm) / newSpeed;
        const lead = (LEAD_BEATS * 60) / (s.bpm * newSpeed);
        const newNow = (fileNow - s.from) * scale + lead;

        s.speed = newSpeed;
        s.scale = scale;
        s.lead = lead;
        let endT = 0;
        for (const it of s.items) {
            it.t = (it.f - s.from) * scale + lead;
            it.d = Math.max(0.05, it.fd * scale);
            it.h = Math.max(14, it.d * CONTAINER_H / lead);
            endT = Math.max(endT, it.t + it.d);
            if (it.el) { it.el.remove(); it.el = null; }   // створиться заново з новою геометрією
        }
        s.endT = endT + WINDOW + 0.5;

        Tone.Transport.seconds = newNow;
        updateTempoLabel();
    }

    function finishSession(reason) {
        const s = session;
        if (!s || s.state === 'done') return;
        const now = Tone.Transport.seconds;
        Tone.Transport.stop();
        Tone.Transport.cancel();
        s.state = 'done';
        synth?.releaseAll();
        for (const it of s.items) {
            if (it.el) { it.el.remove(); it.el = null; }
        }
        keyboardEl.querySelectorAll('.key.active').forEach((k) => k.classList.remove('active'));

        if (s.mode === 'practice') {
            const r = summarize(s, reason === 'end' ? Infinity : now);
            if (r.expected > 0) {
                showResults(r);
                if (reason === 'end') recordPlay(r);
            }
        }

        if (reason === 'end' && E.loopCheck.checked) {
            loopTimer = setTimeout(() => startSession({ clearResults: false }), 600);
        }
        updateButtons();
    }

    // === ПІДСУМОК ТРЕНУВАННЯ ===
    function summarize(s, upTo) {
        const expected = s.items.filter((i) => i.expect && i.t <= upTo);
        const hits = expected.filter((i) => i.status === 'hit');
        const counts = { perfect: 0, good: 0, ok: 0 };
        hits.forEach((i) => { counts[i.grade]++; });
        const points = hits.reduce((a, i) => a + i.points, 0);
        const accuracy = expected.length ? points / (expected.length * POINTS.perfect) * 100 : 0;
        const devMs = mean(hits.map((i) => Math.abs(i.err))) * 1000;
        const signedMs = mean(hits.map((i) => i.err)) * 1000;

        // Темп гравця: співвідношення очікуваних і фактичних інтервалів між послідовними нотами
        const sorted = [...hits].sort((a, b) => a.t - b.t);
        const ratios = [];
        for (let k = 1; k < sorted.length; k++) {
            const dE = sorted[k].t - sorted[k - 1].t;
            const dU = sorted[k].userT - sorted[k - 1].userT;
            if (dE > 0.15 && dU > 0.02) ratios.push(dE / dU);
        }
        const r = median(ratios);

        return {
            expected: expected.length,
            hits: hits.length,
            counts,
            missed: expected.length - hits.length,
            extra: s.extra,
            points,
            accuracy,
            devMs,
            signedMs,
            userBpm: r ? s.bpm * s.speed * r : null,
            targetBpm: s.bpm * s.speed
        };
    }

    function showResults(r) {
        const timing = r.hits
            ? `Середній зсув: ${r.devMs.toFixed(0)} мс (в середньому ${r.signedMs >= 0 ? 'пізніше' : 'раніше'}, ${Math.abs(r.signedMs).toFixed(0)} мс)`
            : 'Жодної влучної ноти';
        const tempo = r.userBpm
            ? `Ваш темп: ~${r.userBpm.toFixed(0)} BPM (ціль ${r.targetBpm.toFixed(0)})`
            : '';
        E.resultsPanel.innerHTML = `
            <div class="results-card">
                <div class="res-title">Підсумок тренування</div>
                <div>Точність: <b>${r.accuracy.toFixed(1)}%</b> · Бали: <b>${r.points}</b></div>
                <div>Ідеально: ${r.counts.perfect} · Добре: ${r.counts.good} · Ок: ${r.counts.ok} · Пропущено: ${r.missed} · Зайві натискання: ${r.extra}</div>
                <div>${timing}</div>
                ${tempo ? `<div>${tempo}</div>` : ''}
            </div>`;
    }

    function recordPlay(r) {
        stats.totalPlays += 1;
        const n = stats.totalPlays;
        stats.avgAccuracy = (stats.avgAccuracy * (n - 1) + r.accuracy) / n;
        stats.avgDeviationMs = (stats.avgDeviationMs * (n - 1) + r.devMs) / n;
        stats.bestScore = Math.max(stats.bestScore, r.points);
        stats.records.push({
            date: new Date().toLocaleString(),
            score: r.points,
            accuracy: +r.accuracy.toFixed(1),
            deviationMs: Math.round(r.devMs),
            targetBpm: Math.round(r.targetBpm),
            tempo: r.userBpm ? Math.round(r.userBpm) : null
        });
        if (stats.records.length > 100) stats.records.splice(0, stats.records.length - 100);
        saveStats();
        updateStatsDisplay();
    }

    function updateStatsDisplay() {
        E.statsDisplay.innerHTML = `
            🏆 Найкращий рахунок: ${stats.bestScore}<br>
            🎯 Середня точність: ${stats.avgAccuracy.toFixed(1)}%<br>
            ⏱ Середній зсув: ${stats.avgDeviationMs.toFixed(0)} мс<br>
            📊 Всього тренувань: ${stats.totalPlays}`;
    }

    function updateLive() {
        E.scoreDisplay.textContent = session ? session.score : 0;
        E.missDisplay.textContent = session ? session.missed : 0;
        E.extraDisplay.textContent = session ? session.extra : 0;
    }

    function updateTempoLabel() {
        if (!midiData) { E.tempoDisplay.textContent = '—'; return; }
        const src = E.tempoModeSelect.value === 'custom' ? 'власний' : 'з файлу';
        E.tempoDisplay.textContent = `${getPlaybackBpm().toFixed(0)} BPM (${src})`;
    }

    function updateButtons() {
        const st = session ? session.state : 'idle';
        const hasMidi = !!midiData;
        if (isRecording) {
            E.playBtn.disabled = true;
            E.pauseBtn.disabled = true;
            E.stopBtn.disabled = true;
            E.recBtn.disabled = false;
            E.saveMidiBtn.disabled = true;
            return;
        }
        E.recBtn.disabled = st === 'playing' || st === 'paused';
        E.saveMidiBtn.disabled = recordedEvents.length === 0;
        E.playBtn.disabled = !hasMidi || st === 'playing';
        E.playBtn.textContent = st === 'paused' ? 'Продовжити' : 'Play';
        E.pauseBtn.disabled = st !== 'playing';
        E.stopBtn.disabled = st !== 'playing' && st !== 'paused';
    }

    // === ОБРОБКА НОТ (MIDI, клавіатура, запис, калібрування) ===
    function practiceNoteOn(midi) {
        const s = session;
        if (!s || s.mode !== 'practice' || s.state !== 'playing') return;
        const now = Tone.Transport.seconds - getLatency();

        let best = null;
        let bestDist = Infinity;
        for (const it of s.items) {
            if (!it.expect || it.status !== 'pending' || it.midi !== midi) continue;
            const dist = Math.abs(now - it.t);
            if (dist <= WINDOW && dist < bestDist) { best = it; bestDist = dist; }
        }

        if (!best) {
            s.extra++;
            flash('Зайва нота', 'bad');
            updateLive();
            return;
        }

        const err = now - best.t;
        const a = Math.abs(err);
        const grade = a <= GRADE_PERFECT ? 'perfect' : a <= GRADE_GOOD ? 'good' : 'ok';
        best.status = 'hit';
        best.err = err;
        best.userT = now;
        best.grade = grade;
        best.points = POINTS[grade];
        s.score += best.points;
        paintNote(best, 'hit');

        const label = { perfect: 'Ідеально', good: 'Добре', ok: 'Ок' }[grade];
        flash(`${label} +${best.points} (${err >= 0 ? '+' : ''}${Math.round(err * 1000)} мс)`, grade);
        updateLive();
    }

    function flash(text, cls) { flashFeedback(text, cls); }

    function onNoteOn(midi, velocity = 0.8) {
        if (midi < 0 || midi > 127) return;
        const name = midiToName(midi);
        if (!synth) {
            console.warn('Synth не ініціалізовано');
            return;
        }
        if (midiOutputs.length > 0) {
            const v = Math.min(127, Math.round(velocity * 127));
            midiOutputs.forEach((o) => o.send([0x90, midi, v]));
        }
        synth.triggerAttack(name, undefined, velocity);
        highlightOn(name);

        if (isRecording) {
            recordedEvents.push({ type: 'noteOn', note: midi, t: Tone.now(), vel: Math.round(velocity * 127) });
            return;
        }
        if (calibration) calibrationHit(Tone.now());
        if (session && session.state === 'playing' && session.mode === 'practice') {
            practiceNoteOn(midi);
        } else {
            spawnUserNote(midi);
        }
    }

    function onNoteOff(midi) {
        const name = midiToName(midi);
        if (midiOutputs.length > 0) midiOutputs.forEach((o) => o.send([0x80, midi, 0]));
        if (!synth) return;
        synth.triggerRelease(name);
        highlightOff(name);
        if (isRecording) {
            recordedEvents.push({ type: 'noteOff', note: midi, t: Tone.now() });
            return;
        }
        releaseUserNote(midi);
    }

    function handleMIDIMessage(e) {
        const [status, d1, d2] = e.data;
        const cmd = status >> 4;
        if (cmd === 9 && d2 > 0) onNoteOn(d1, d2 / 127);
        else if (cmd === 8 || (cmd === 9 && d2 === 0)) onNoteOff(d1);
    }

    function onMIDISuccess(access) {
        const inputs = Array.from(access.inputs.values());
        inputs.forEach((inp) => { inp.onmidimessage = handleMIDIMessage; });
        midiOutputs = Array.from(access.outputs.values());
        access.onstatechange = (ev) => {
            if (ev.port.type === 'input' && ev.port.state === 'connected') {
                ev.port.onmidimessage = handleMIDIMessage;
            } else if (ev.port.type === 'output') {
                midiOutputs = Array.from(access.outputs.values());
            }
        };
        console.log('WebMIDI готовий. Inputs:', inputs.length, 'Outputs:', midiOutputs.length);
    }

    // Клавіші A–K / W E T Y U — грати без MIDI-клавіатури; Z/X — октава вниз/вгору
    window.addEventListener('keydown', (e) => {
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.repeat) return;
        const k = e.key.toLowerCase();
        if (k === 'z' || k === 'x') {
            octaveShift = Math.max(-3, Math.min(3, octaveShift + (k === 'x' ? 1 : -1)));
            return;
        }
        if (!(k in PC_KEY_MAP)) return;
        const midi = 60 + octaveShift * 12 + PC_KEY_MAP[k];
        if (midi > LAST_MIDI || midi < FIRST_MIDI) return;
        pcKeys.set(k, midi);
        onNoteOn(midi, 0.8);
    });

    window.addEventListener('keyup', (e) => {
        const k = e.key.toLowerCase();
        if (!pcKeys.has(k)) return;
        onNoteOff(pcKeys.get(k));
        pcKeys.delete(k);
    });

    // === КАЛІБРУВАННЯ ЛАТЕНТНОСТІ ===
    async function toggleCalibration() {
        if (!synth) return alert('Спочатку натисніть "Start (розблокувати аудіо)"');
        if (calibration) return finishCalibration();
        await Tone.start();
        const t0 = Tone.now() + 0.5;
        const clicks = [];
        for (let i = 0; i < CAL_BEATS; i++) {
            const t = t0 + i * CAL_PERIOD;
            clicks.push(t);
            beepSynth.triggerAttackRelease('C6', 0.05, t);
        }
        const totalMs = (t0 - Tone.now() + CAL_BEATS * CAL_PERIOD + 0.4) * 1000;
        calibration = { clicks, offsets: [], timer: setTimeout(finishCalibration, totalMs) };
        E.calibrateBtn.textContent = 'Натискайте в такт… (ще раз — завершити)';
        flashFeedback('Натискайте будь-яку клавішу в такт кліків', '');
    }

    function calibrationHit(t) {
        let best = Infinity;
        calibration.clicks.forEach((c) => {
            const d = t - c;
            if (Math.abs(d) < Math.abs(best)) best = d;
        });
        if (Math.abs(best) < 0.5) calibration.offsets.push(best);
    }

    function finishCalibration() {
        if (!calibration) return;
        clearTimeout(calibration.timer);
        const offsets = calibration.offsets;
        calibration = null;
        E.calibrateBtn.textContent = 'Калібрувати латентність';
        if (offsets.length < 4) {
            flashFeedback('Замало натискань для калібрування. Спробуйте ще раз.', 'bad');
            return;
        }
        const ms = Math.min(300, Math.max(0, Math.round(median(offsets) * 1000)));
        E.latencyInput.value = ms;
        flashFeedback(`Латентність встановлено: ${ms} мс`, 'good');
    }

    // === ФАЙЛ, ТРЕКИ ===
    function buildNotes() {
        allNotes = [];
        midiData.tracks.forEach((tr, ti) => {
            tr.notes.forEach((n) => allNotes.push({
                midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity, track: ti
            }));
        });
        allNotes.sort((a, b) => a.time - b.time);
    }

    function populateTracks() {
        E.trackSelect.innerHTML = '<option value="all">Усі доріжки</option>';
        midiData.tracks.forEach((tr, i) => {
            if (!tr.notes.length) return;
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = `${tr.name || 'Доріжка ' + (i + 1)} (${tr.notes.length} нот)`;
            E.trackSelect.appendChild(opt);
        });
    }

    function updateSplitLabel() {
        const v = parseInt(E.splitInput.value, 10);
        E.splitLabel.textContent = Number.isFinite(v) ? midiToName(v) : '';
    }

    E.midiFileInput.addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        try {
            const song = await loadSong(file);
            if (session && session.state !== 'done') finishSession('stop');
            midiData = song;
            buildNotes();
            populateTracks();
            session = null;
            E.resultsPanel.innerHTML = '';
            updateTempoLabel();
            updateButtons();
        } catch (err) {
            console.error('Помилка читання MIDI:', err);
            alert('Помилка при завантаженні MIDI. Перевірте файл.');
        }
    });

    // === КНОПКИ ===
    E.startButton.addEventListener('click', initAudio);

    E.playBtn.addEventListener('click', async () => {
        if (isRecording) return;
        try { await Tone.start(); } catch (err) { console.error(err); }
        if (session && session.state === 'paused') return resumeSession();
        startSession({ clearResults: true });
    });

    E.pauseBtn.addEventListener('click', pauseSession);

    E.stopBtn.addEventListener('click', () => {
        clearTimeout(loopTimer);
        finishSession('stop');
        E.timeDisplay.textContent = '00:00';
        updateLive();
    });

    E.stopAllBtn.addEventListener('click', () => {
        clearTimeout(loopTimer);
        finishSession('stop');
        synth?.releaseAll();
        userNotes.forEach((u) => u.el.remove());
        userNotes.clear();
        E.timeDisplay.textContent = '00:00';
        updateLive();
    });

    E.recBtn.addEventListener('click', async () => {
        if (session && session.state !== 'done') {
            alert('⚠️ Спочатку зупиніть відтворення!');
            return;
        }
        await Tone.start();
        if (!isRecording) {
            recordedEvents = [];
            isRecording = true;
            E.recBtn.textContent = 'Stop Recording';
            beepSound('C5', 0.1);
        } else {
            isRecording = false;
            E.recBtn.textContent = 'Rec';
            beepSound('C4', 0.1);
        }
        updateButtons();
    });

    E.saveMidiBtn.addEventListener('click', () => {
        if (!recordedEvents.length) return alert('Немає записаних нот');
        const first = Math.min(...recordedEvents.map((ev) => ev.t));
        const events = recordedEvents.map((ev) => ({ ...ev, t: ev.t - first }));
        const midi = new window.Midi();
        const track = midi.addTrack();
        midi.header.setTempo(getPlaybackBpm());
        const onMap = new Map();
        for (const ev of events) {
            if (ev.type === 'noteOn') {
                onMap.set(ev.note, ev);
            } else if (ev.type === 'noteOff') {
                const on = onMap.get(ev.note);
                if (on) {
                    track.addNote({ midi: ev.note, time: on.t, duration: Math.max(0.05, ev.t - on.t), velocity: (on.vel ?? 100) / 127 });
                    onMap.delete(ev.note);
                }
            }
        }
        onMap.forEach((on) => track.addNote({ midi: on.note, time: on.t, duration: 0.5, velocity: (on.vel ?? 100) / 127 }));

        const buffer = new Uint8Array(midi.toArray()).buffer;
        const blob = new Blob([buffer], { type: 'audio/midi' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'recorded.mid';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('✅ MIDI-файл успішно збережено!');
    });

    E.calibrateBtn.addEventListener('click', toggleCalibration);

    E.speedSlider.addEventListener('input', () => {
        E.speedDisplay.textContent = `${parseFloat(E.speedSlider.value).toFixed(1)}x`;
        applySpeedChange();
    });
    E.bpmInput.addEventListener('input', updateTempoLabel);
    E.tempoModeSelect.addEventListener('change', updateTempoLabel);
    E.splitInput.addEventListener('input', () => { updateSplitLabel(); applySelectionChange(); });
    E.trackSelect.addEventListener('change', applySelectionChange);
    E.partSelect.addEventListener('change', applySelectionChange);
    E.accompanimentCheck.addEventListener('change', applySelectionChange);
    E.instrumentSelect.addEventListener('change', () => {
        if (!synth) return;
        synth.releaseAll();
        setupSynth();
    });
    E.volumeSlider.addEventListener('input', setSynthVolume);
    E.noteLabelSelect.addEventListener('change', refreshNoteLabels);

    // === СТАРТ ===
    buildKeyboard();
    refreshNoteLabels();
    updateSplitLabel();
    updateStatsDisplay();
    updateTempoLabel();
    updateButtons();
    E.audioHint.style.display = 'block';
    rafId = requestAnimationFrame(tick);
    setInterval(audioTick, 10);
    console.log('✅ Ініціалізація завершена');
});
