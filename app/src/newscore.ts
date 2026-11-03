// A blank score to build from: the parts, key, time signature, speed and number of bars the reader chose,
// written as a MuseScore file (the 3.x .mscx format, which the engine reads like any other score).
// Every bar starts as a whole-bar rest, ready for Edit mode.

/** A line of the score: a staff with a name the reader chose and a clef. */
export interface LineChoice { name: string; clef: "G" | "G8vb" | "F" }

export const CLEFS: [LineChoice["clef"], string][] = [["G", "Treble"], ["G8vb", "Treble, an octave lower"], ["F", "Bass"]];

/** A range a voice or an instrument playing such a line is expected to cover. */
const RANGE: Record<LineChoice["clef"], [number, number]> = { G: [55, 84], G8vb: [43, 72], F: [36, 64] };

/** Major keys by the number of sharps (+) or flats (-). */
export const KEYS: [number, string][] = [
    [0, "C major"], [1, "G major"], [2, "D major"], [3, "A major"], [4, "E major"], [5, "B major"], [6, "F♯ major"], [7, "C♯ major"],
    [-1, "F major"], [-2, "B♭ major"], [-3, "E♭ major"], [-4, "A♭ major"], [-5, "D♭ major"], [-6, "G♭ major"], [-7, "C♭ major"],
];

export const TIMES: [number, number][] = [[4, 4], [3, 4], [2, 4], [6, 8], [2, 2], [12, 8], [5, 4]];

export interface NewScoreOptions {
    title: string;
    lines: LineChoice[]; // top to bottom
    key: number;
    time: [number, number];
    bpm: number;
    bars: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function shortName(name: string): string {
    const t = name.trim();
    return t.length <= 4 ? t : t.slice(0, 3) + ".";
}

function lineXml(l: LineChoice, staff: number, bracketSpan: number): string {
    const name = esc(l.name.trim() || "Line");
    const [low, high] = RANGE[l.clef];
    return `    <Part>
      <Staff id="${staff}">
        <StaffType group="pitched">
          <name>stdNormal</name>
          </StaffType>
${l.clef !== "G" ? `        <defaultClef>${l.clef}</defaultClef>\n` : ""}${bracketSpan > 1 ? `        <bracket type="0" span="${bracketSpan}" col="0"/>\n` : ""}        </Staff>
      <trackName>${name}</trackName>
      <Instrument>
        <longName>${name}</longName>
        <shortName>${esc(shortName(l.name))}</shortName>
        <trackName>${name}</trackName>
        <minPitchP>${low}</minPitchP>
        <maxPitchP>${high}</maxPitchP>
        <minPitchA>${low}</minPitchA>
        <maxPitchA>${high}</maxPitchA>
        <instrumentId>voice.vocals</instrumentId>
${l.clef !== "G" ? `        <clef>${l.clef}</clef>\n` : ""}        <Articulation>
          <velocity>100</velocity>
          <gateTime>100</gateTime>
          </Articulation>
        <Channel>
          <program value="5"/>
          <synti>Fluid</synti>
          <midiPort>0</midiPort>
          <midiChannel>0</midiChannel>
          </Channel>
        </Instrument>
      </Part>
`;
}

/** The score as the text of an .mscx file. */
export function buildScore(o: NewScoreOptions): string {
    const lines = o.lines.length ? o.lines : [{ name: "Line 1", clef: "G" as const }];
    const staffCount = lines.length;
    const [num, den] = o.time;
    const title = o.title.trim() || "Untitled";
    let parts = "";
    lines.forEach((l, n) => { parts += lineXml(l, n + 1, n === 0 ? staffCount : 1); });
    // the quarter note is a beat unless the signature counts in eighths; MuseScore keeps tempo in quarters a second
    const beatIsQuarter = den !== 8 || num % 3 !== 0;
    const qps = (beatIsQuarter ? o.bpm : o.bpm * 1.5) / 60;
    const bars = Math.max(1, Math.min(300, Math.round(o.bars)));
    let staves = "";
    for (let s = 1; s <= staffCount; s++) {
        staves += `    <Staff id="${s}">\n`;
        if (s === 1) {
            staves += `      <VBox>
        <height>10</height>
        <bottomGap>14.1431</bottomGap>
        <Text>
          <style>Title</style>
          <text>${esc(title)}</text>
          </Text>
        </VBox>
`;
        }
        for (let b = 1; b <= bars; b++) {
            let m = "      <Measure>\n        <voice>\n";
            if (b === 1) {
                m += `          <KeySig>\n            <accidental>${o.key}</accidental>\n            </KeySig>\n`;
                m += `          <TimeSig>\n            <sigN>${num}</sigN>\n            <sigD>${den}</sigD>\n            </TimeSig>\n`;
                if (s === 1) {
                    m += `          <Tempo>\n            <tempo>${qps.toFixed(5)}</tempo>\n            <followText>1</followText>\n            <text><sym>metNoteQuarterUp</sym>${beatIsQuarter ? "" : "<sym>metAugmentationDot</sym>"} = ${Math.round(o.bpm)}</text>\n            </Tempo>\n`;
                }
            }
            m += `          <Rest>\n            <durationType>measure</durationType>\n            <duration>${num}/${den}</duration>\n            </Rest>\n`;
            if (b === bars) {
                m += "          <BarLine>\n            <subtype>end</subtype>\n            </BarLine>\n";
            }
            staves += m + "          </voice>\n        </Measure>\n";
        }
        staves += "      </Staff>\n";
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="3.01">
  <programVersion>3.0.4</programVersion>
  <programRevision>cda4080</programRevision>
  <Score>
    <LayerTag id="0" tag="default"></LayerTag>
    <currentLayer>0</currentLayer>
    <Division>480</Division>
    <showInvisible>1</showInvisible>
    <showUnprintable>1</showUnprintable>
    <showFrames>1</showFrames>
    <showMargins>0</showMargins>
    <metaTag name="creationDate">${new Date().toISOString()}</metaTag>
    <metaTag name="workTitle">${esc(title)}</metaTag>
${parts}${staves}    </Score>
  </museScore>
`;
}
