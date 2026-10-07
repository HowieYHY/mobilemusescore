// Replays the drawing commands recorded by engine/core/painter.cpp onto a
// canvas. Coordinates are MuseScore engraving units (1200 per inch).
// Text and music symbols use the very font files MuseScore measured them
// with, loaded as web fonts.

export const UNITS_PER_INCH = 1200;
export const CSS_PX_PER_INCH = 96;

type Op = any[];

const fontFamilies = new Map<string, string>(); // resource path -> CSS family
const fontLoads = new Map<string, Promise<void>>();

function familyFor(resPath: string): string {
    let fam = fontFamilies.get(resPath);
    if (!fam) {
        fam = "mss-font-" + fontFamilies.size;
        fontFamilies.set(resPath, fam);
    }
    return fam;
}

// Loads the web fonts a page needs before drawing it.
export async function ensureFonts(ops: Op[], base: string): Promise<void> {
    const needed = new Set<string>();
    for (const op of ops) {
        if (op[0] === "F" && op[1]) {
            needed.add(op[1]);
        }
    }
    await Promise.all([...needed].map((resPath) => {
        let p = fontLoads.get(resPath);
        if (!p) {
            const url = base + "res/" + encodeURI(resPath.replace(/^:\//, ""));
            const face = new FontFace(familyFor(resPath), `url("${url}")`);
            // A font the browser refuses must not stop the page being drawn:
            // its text then falls back to another font (see scripts/fix-fonts.py)
            p = face.load().then((f) => {
                (document.fonts as any).add(f);
            }, (err) => {
                console.warn(`font ${resPath} could not be loaded:`, err);
            });
            fontLoads.set(resPath, p);
        }
        return p;
    }));
}

const images = new Map<string, HTMLImageElement>(); // data URL -> decoded image

// Decodes the pictures a page needs before drawing it.
export async function ensureImages(ops: Op[]): Promise<void> {
    await Promise.all(ops.filter((op) => op[0] === "img" && op[5] && !images.has(op[5])).map(async (op) => {
        const img = new Image();
        img.src = op[5];
        try {
            await img.decode();
            images.set(op[5], img);
        } catch (err) {
            // undecodable picture: drawn as an outline below
        }
    }));
}

interface DrawState {
    pen: { color: string; width: number; cap: CanvasLineCap; join: CanvasLineJoin; dash: number[] } | null;
    brush: string | null;
    font: string;
}

const CAPS: CanvasLineCap[] = ["butt", "square", "round"];
const JOINS: CanvasLineJoin[] = ["miter", "bevel", "round"];

function cssColor(hex: string): string {
    // "#rrggbbaa" -> rgba()
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const a = parseInt(hex.slice(7, 9), 16) / 255;
    return `rgba(${r},${g},${b},${a})`;
}

// Draws one page. `scale` maps engraving units to canvas pixels.
export function drawPage(ctx: CanvasRenderingContext2D, ops: Op[], scale: number) {
    let st: DrawState = { pen: { color: "#000", width: 0, cap: "butt", join: "miter", dash: [] }, brush: null, font: "10px serif" };
    const stack: DrawState[] = [];
    let tf = [1, 0, 0, 1, 0, 0];

    const applyTransform = () => {
        ctx.setTransform(scale * tf[0], scale * tf[1], scale * tf[2], scale * tf[3], scale * tf[4], scale * tf[5]);
    };

    const applyPen = () => {
        const p = st.pen;
        if (!p) {
            return;
        }
        ctx.strokeStyle = p.color;
        // width 0 is a "cosmetic" one-pixel line in Qt
        const det = Math.sqrt(Math.abs(tf[0] * tf[3] - tf[1] * tf[2])) * scale || 1;
        ctx.lineWidth = p.width > 0 ? p.width : 1 / det;
        ctx.lineCap = p.cap;
        ctx.lineJoin = p.join;
        ctx.setLineDash(p.dash.length ? p.dash.map((d) => d * (p.width || 1 / det)) : []);
    };

    const fillAndStroke = (path: Path2D, rule: CanvasFillRule, fill: boolean) => {
        if (fill && st.brush) {
            ctx.fillStyle = st.brush;
            ctx.fill(path, rule);
        }
        if (st.pen) {
            applyPen();
            ctx.stroke(path);
        }
    };

    ctx.save();
    applyTransform();

    for (const op of ops) {
        switch (op[0]) {
        case "T":
            tf = [op[1] / 1000, op[2] / 1000, op[3] / 1000, op[4] / 1000, op[5], op[6]];
            applyTransform();
            break;
        case "P":
            st.pen = op[1] === null ? null
                : { color: cssColor(op[1]), width: op[2], cap: CAPS[op[3]] || "butt", join: JOINS[op[4]] || "miter", dash: op[5] || [] };
            break;
        case "B":
            st.brush = op[1] === null ? null : cssColor(op[1]);
            break;
        case "F": {
            const fam = op[1] ? familyFor(op[1]) : "serif";
            // the face file already carries weight and style; don't synthesize
            st.font = `${op[2]}px "${fam}"`;
            break;
        }
        case "S":
            stack.push({ ...st, pen: st.pen && { ...st.pen } });
            ctx.save();
            break;
        case "R":
            st = stack.pop() || st;
            ctx.restore();
            applyTransform();
            break;
        case "p": {
            const d: number[] = op[2];
            const path = new Path2D();
            for (let i = 0; i < d.length;) {
                const c = d[i];
                if (c === 0) {
                    path.moveTo(d[i + 1], d[i + 2]);
                    i += 3;
                } else if (c === 1) {
                    path.lineTo(d[i + 1], d[i + 2]);
                    i += 3;
                } else {
                    path.bezierCurveTo(d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6]);
                    i += 7;
                }
            }
            fillAndStroke(path, op[1] ? "nonzero" : "evenodd", true);
            break;
        }
        case "g": {
            const pts: number[] = op[2];
            const path = new Path2D();
            for (let i = 0; i + 1 < pts.length; i += 2) {
                i === 0 ? path.moveTo(pts[i], pts[i + 1]) : path.lineTo(pts[i], pts[i + 1]);
            }
            const polyline = op[1] === 3;
            if (!polyline) {
                path.closePath();
            }
            fillAndStroke(path, op[1] === 0 ? "evenodd" : "nonzero", !polyline);
            break;
        }
        case "t":
        case "y": {
            // Qt draws text with the pen colour
            ctx.font = st.font;
            ctx.fillStyle = st.pen ? st.pen.color : "#000";
            const text = op[0] === "y" ? String.fromCodePoint(op[3]) : op[3];
            ctx.fillText(text, op[1], op[2]);
            break;
        }
        case "tr": {
            const [, x, y, w, h, align, text] = op;
            ctx.font = st.font;
            ctx.fillStyle = st.pen ? st.pen.color : "#000";
            // Qt alignment flags: 0x1 left, 0x2 right, 0x4 hcenter, 0x20 top, 0x40 bottom, 0x80 vcenter
            ctx.textAlign = align & 0x2 ? "right" : align & 0x4 ? "center" : "left";
            ctx.textBaseline = align & 0x20 ? "top" : align & 0x40 ? "bottom" : align & 0x80 ? "middle" : "alphabetic";
            const tx = align & 0x2 ? x + w : align & 0x4 ? x + w / 2 : x;
            const ty = align & 0x20 ? y : align & 0x40 ? y + h : align & 0x80 ? y + h / 2 : y;
            ctx.fillText(text, tx, ty);
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            break;
        }
        case "c":
            if (op.length >= 5) {
                ctx.beginPath();
                ctx.rect(op[1], op[2], op[3], op[4]);
                ctx.clip();
            }
            break;
        case "m": {
            const path = new Path2D();
            path.rect(op[1], op[2], op[3], op[4]);
            const r: number[] = op[5];
            for (let i = 0; i + 3 < r.length; i += 4) {
                path.rect(r[i], r[i + 1], r[i + 2], r[i + 3]);
            }
            ctx.clip(path, "evenodd");
            break;
        }
        case "img": {
            const img = op[5] && images.get(op[5]);
            if (img) {
                ctx.drawImage(img, op[1], op[2], op[3], op[4]);
                break;
            }
            // picture missing or undecodable: outline where it goes
            ctx.save();
            ctx.strokeStyle = "rgba(0,0,0,0.25)";
            ctx.setLineDash([20, 20]);
            ctx.lineWidth = 4;
            ctx.strokeRect(op[1], op[2], op[3], op[4]);
            ctx.restore();
            break;
        }
        }
    }

    ctx.restore();
}
