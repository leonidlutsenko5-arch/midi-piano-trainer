// === MUSICXML (.xml, .musicxml, .mxl) ===
// Розбирає score-partwise MusicXML і повертає об'єкт у тому самому форматі,
// що й @tonejs/midi: { header: { tempos: [{bpm}] }, tracks: [{ name, notes: [{midi, time, duration, velocity}] }] }
// Тому весь тренажер працює з ним без змін.
// Підтримується: кілька партій і штабків, акорди, лігатури, паузи, повтори з кінцівками,
// зміни темпу (sound tempo і metronome), динаміка (p, f тощо), ноти прикраси пропускаються.
// Не підтримується: score-timewise, D.C./D.S. переходи, pickup-повтори поза структурою.

(function (global) {
    const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const DYNAMICS = { ppp: 0.2, pp: 0.3, p: 0.45, mp: 0.6, mf: 0.75, f: 0.9, ff: 1, fff: 1, fp: 0.6, sfz: 0.9 };
    const BEAT_UNIT = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625 };
    const DEFAULT_QPM = 120;
    const DEFAULT_VEL = 0.8;

    const kids = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 1);
    const kid = (el, name) => kids(el).find((n) => n.tagName === name) || null;
    const kidsNamed = (el, name) => kids(el).filter((n) => n.tagName === name);
    const textOf = (el, name) => { const c = kid(el, name); return c ? c.textContent.trim() : null; };
    const num = (el, name, fallback = 0) => {
        const v = parseFloat(textOf(el, name));
        return Number.isFinite(v) ? v : fallback;
    };

    // --- Повтори та кінцівки ---
    function barlineInfo(measure) {
        const info = { fwd: false, bwd: false, times: 2, endNums: [], endStop: false };
        for (const bl of kidsNamed(measure, 'barline')) {
            const rep = kid(bl, 'repeat');
            if (rep) {
                if (rep.getAttribute('direction') === 'forward') info.fwd = true;
                if (rep.getAttribute('direction') === 'backward') {
                    info.bwd = true;
                    info.times = parseInt(rep.getAttribute('times'), 10) || 2;
                }
            }
            const end = kid(bl, 'ending');
            if (end) {
                const type = end.getAttribute('type');
                if (type === 'start') {
                    info.endNums = (end.getAttribute('number') || '1')
                        .split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite);
                }
                if (type === 'stop' || type === 'discontinue') info.endStop = true;
            }
        }
        return info;
    }

    // Розгортає повтори: повертає масив тактів у порядку відтворення.
    function unrollRepeats(measures) {
        const infos = measures.map(barlineInfo);
        const seq = [];
        let i = 0;
        let repStart = 0;
        let pass = 1;
        let jumped = false;   // true, якщо щойно повернулись до початку повтору
        let guard = 0;
        while (i < measures.length) {
            if (++guard > 50000) break;   // захист від зациклення на битих файлах
            const inf = infos[i];
            // Початковий знак повтору не має скидати лічильник, коли ми повернулися до нього
            if (inf.fwd && !(jumped && i === repStart)) { repStart = i; pass = 1; }
            jumped = false;
            if (inf.endNums.length && !inf.endNums.includes(pass)) {
                // Ця кінцівка не для поточного проходу: пропускаємо її до кінця
                let j = i;
                while (j < measures.length && !infos[j].endStop) j++;
                i = j + 1;
                continue;
            }
            seq.push(measures[i]);
            if (inf.bwd) {
                if (pass < inf.times) {
                    pass++;
                    i = repStart;
                    jumped = true;
                    continue;
                }
                pass = 1;
            }
            i++;
        }
        return seq;
    }

    // --- Темп і ноти ---
    function metronomeQpm(direction) {
        for (const dt of kidsNamed(direction, 'direction-type')) {
            const met = kid(dt, 'metronome');
            if (!met) continue;
            const perMinute = parseFloat(textOf(met, 'per-minute'));
            const unitName = textOf(met, 'beat-unit');
            if (!Number.isFinite(perMinute) || !BEAT_UNIT[unitName]) continue;
            const dots = kidsNamed(met, 'beat-unit-dot').length;
            let factor = BEAT_UNIT[unitName];
            if (dots) factor *= 1 + (1 - Math.pow(0.5, dots));
            return perMinute * factor;   // переводимо в чверті за хвилину
        }
        return null;
    }

    function pitchToMidi(pitch) {
        const step = STEP[textOf(pitch, 'step')];
        const octave = parseInt(textOf(pitch, 'octave'), 10);
        const alter = parseFloat(textOf(pitch, 'alter') || '0');
        if (step === undefined || !Number.isFinite(octave)) return null;
        return (octave + 1) * 12 + step + Math.round(alter);
    }

    // Розбирає одну партію. Час зберігається в quarter-нотах (beats), щоб темп можна було
    // застосувати після повного розбору.
    function parsePart(partEl) {
        const measures = kidsNamed(partEl, 'measure');
        const seq = unrollRepeats(measures);

        let divisions = 1;
        let velocity = DEFAULT_VEL;
        let beatOffset = 0;               // початок поточного такту, в quarter-нотах
        const tempoPoints = [];           // {beat, qpm}
        const notes = [];                 // {midi, staff, beat, dur, vel}
        const pendingTies = new Map();    // ключ staff:midi -> нота, що триває через лігатуру

        const addTie = (n) => {
            const key = n.staff + ':' + n.midi;
            if (n.tieStop && pendingTies.has(key)) {
                const prev = pendingTies.get(key);
                prev.dur += n.dur;
                if (!n.tieStart) pendingTies.delete(key);
                return;
            }
            notes.push(n);
            if (n.tieStart) pendingTies.set(key, n);
        };

        for (const m of seq) {
            let cursor = 0;           // позиція в такті, в divisions
            let lastStart = 0;        // початок останньої не-акордної ноти
            let maxCursor = 0;

            for (const el of kids(m)) {
                switch (el.tagName) {
                    case 'attributes': {
                        const d = parseFloat(textOf(el, 'divisions'));
                        if (Number.isFinite(d) && d > 0) divisions = d;
                        break;
                    }
                    case 'backup':
                        cursor -= num(el, 'duration');
                        break;
                    case 'forward':
                        cursor += num(el, 'duration');
                        maxCursor = Math.max(maxCursor, cursor);
                        break;
                    case 'direction': {
                        const beat = beatOffset + cursor / divisions;
                        const sound = kid(el, 'sound');
                        let qpm = sound && parseFloat(sound.getAttribute('tempo'));
                        if (!Number.isFinite(qpm)) qpm = metronomeQpm(el);
                        if (Number.isFinite(qpm) && qpm > 0) tempoPoints.push({ beat, qpm });
                        for (const dt of kidsNamed(el, 'direction-type')) {
                            for (const dyn of kidsNamed(dt, 'dynamics')) {
                                for (const c of kids(dyn)) {
                                    if (DYNAMICS[c.tagName] !== undefined) velocity = DYNAMICS[c.tagName];
                                }
                            }
                        }
                        break;
                    }
                    case 'note': {
                        const isChord = kid(el, 'chord') !== null;
                        const isGrace = kid(el, 'grace') !== null;
                        const isRest = kid(el, 'rest') !== null;
                        const dur = num(el, 'duration');
                        const start = isChord ? lastStart : cursor;
                        if (!isChord) lastStart = cursor;

                        if (!isRest && !isGrace) {
                            const pitch = kid(el, 'pitch');
                            const midi = pitch ? pitchToMidi(pitch) : null;
                            if (midi !== null) {
                                const tieTypes = kidsNamed(el, 'tie').map((t) => t.getAttribute('type'));
                                addTie({
                                    midi,
                                    staff: parseInt(textOf(el, 'staff') || '1', 10),
                                    beat: beatOffset + start / divisions,
                                    dur: dur / divisions,
                                    vel: velocity,
                                    tieStart: tieTypes.includes('start'),
                                    tieStop: tieTypes.includes('stop')
                                });
                            }
                        }
                        if (!isChord) cursor += dur;
                        maxCursor = Math.max(maxCursor, cursor);
                        break;
                    }
                }
            }
            beatOffset += maxCursor / divisions;
        }

        // Остання крапка темпу на тій самій позиції перекриває попередню
        tempoPoints.sort((a, b) => a.beat - b.beat);
        const tempos = [];
        for (const p of tempoPoints) {
            if (tempos.length && tempos[tempos.length - 1].beat === p.beat) tempos[tempos.length - 1] = p;
            else tempos.push(p);
        }
        if (!tempos.length || tempos[0].beat > 0) tempos.unshift({ beat: 0, qpm: DEFAULT_QPM });

        return { notes, tempos };
    }

    // Перетворює quarter-ноти в секунди з урахуванням зміни темпу.
    function beatsToSeconds(tempos) {
        return (b) => {
            let sec = 0;
            let pb = 0;
            let q = tempos[0].qpm;
            for (let k = 1; k < tempos.length; k++) {
                const p = tempos[k];
                if (p.beat >= b) break;
                sec += (p.beat - pb) * 60 / q;
                pb = p.beat;
                q = p.qpm;
            }
            return sec + (b - pb) * 60 / q;
        };
    }

    function parseMusicXML(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        const root = doc.documentElement;
        if (!root || root.tagName !== 'score-partwise') {
            throw new Error('Підтримується лише формат score-partwise MusicXML');
        }
        const parts = kidsNamed(root, 'part');
        if (!parts.length) throw new Error('У файлі не знайдено партій');

        // Назви партій зі списку part-list
        const partNames = {};
        const partList = kid(root, 'part-list');
        if (partList) {
            for (const sp of kidsNamed(partList, 'score-part')) {
                partNames[sp.getAttribute('id')] = textOf(sp, 'part-name') || '';
            }
        }

        const tracks = [];
        let headerTempos = null;

        parts.forEach((partEl, pi) => {
            const parsed = parsePart(partEl);
            const toSec = beatsToSeconds(parsed.tempos);
            if (pi === 0) headerTempos = parsed.tempos;

            // Окремий трек на кожен штабок партії
            const byStaff = new Map();
            for (const n of parsed.notes) {
                if (!byStaff.has(n.staff)) byStaff.set(n.staff, []);
                const start = toSec(n.beat);
                const end = toSec(n.beat + n.dur);
                byStaff.get(n.staff).push({
                    midi: n.midi,
                    time: start,
                    duration: Math.max(0.05, end - start),
                    velocity: n.vel
                });
            }

            const partId = partEl.getAttribute('id');
            const partLabel = partNames[partId] || `Партія ${pi + 1}`;
            Array.from(byStaff.keys()).sort((a, b) => a - b).forEach((staff) => {
                const notes = byStaff.get(staff).sort((a, b) => a.time - b.time);
                const suffix = byStaff.size > 1 ? ` · штабок ${staff}` : '';
                tracks.push({ name: partLabel + suffix, notes });
            });
        });

        const firstQpm = headerTempos[0].qpm;
        return {
            header: { tempos: [{ bpm: firstQpm, ticks: 0, time: 0 }] },
            tracks
        };
    }

    // .mxl — ZIP з XML всередині; JSZip має бути завантажений
    async function readMxlText(buffer) {
        if (!global.JSZip) throw new Error('JSZip не завантажено');
        const zip = await global.JSZip.loadAsync(buffer);
        let rootPath = null;
        const container = zip.file('META-INF/container.xml');
        if (container) {
            const cxml = await container.async('string');
            const cdoc = new DOMParser().parseFromString(cxml, 'application/xml');
            const rf = cdoc.getElementsByTagName('rootfile')[0];
            rootPath = rf ? rf.getAttribute('full-path') : null;
        }
        if (!rootPath || !zip.file(rootPath)) {
            rootPath = Object.keys(zip.files).find((n) => /\.(xml|musicxml)$/i.test(n) && !n.startsWith('META-INF/'));
        }
        if (!rootPath) throw new Error('У .mxl не знайдено MusicXML');
        return zip.file(rootPath).async('string');
    }

    global.MusicXML = { parseMusicXML, readMxlText };
})(typeof window !== 'undefined' ? window : globalThis);
