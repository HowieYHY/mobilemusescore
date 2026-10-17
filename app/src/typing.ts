// Typing that leaves nothing for the system to undo (issue #30).
// iPadOS offers "Undo Typing" on a shake or bump for any typing a page still holds, and
// nothing clears it once the browser made it (not even removing the element, measured in
// WebKit). Typing made in code (from `beforeinput`, default prevented) is not recorded, so
// the box never comes. Typing composed by the keyboard (e.g. Chinese) can't be prevented and
// is still recorded.

// A number field. It is type="text" (selection works there, not in type="number"); Enter and
// leaving it call `commit` once if something was typed, as `change` did. Focusing it selects
// all, so typing replaces the number.
export function numberField(el: HTMLInputElement, commit: () => void, step?: (by: number) => void) {
    let typed = false;
    const put = (v: string, caret: number) => {
        el.value = v;
        el.setSelectionRange(caret, caret);
        typed = true;
    };
    el.addEventListener("beforeinput", (e) => {
        e.preventDefault();
        const v = el.value;
        const s = el.selectionStart ?? v.length;
        const end = el.selectionEnd ?? s;
        switch (e.inputType) {
            case "insertText":
            case "insertReplacementText":
            case "insertFromPaste":
            case "insertFromDrop": {
                const text = (e.data ?? e.dataTransfer?.getData("text/plain") ?? "").replace(/\D/g, "");
                const room = el.maxLength > 0 ? el.maxLength - (v.length - (end - s)) : text.length;
                const add = text.slice(0, Math.max(0, room));
                if (add) {
                    put(v.slice(0, s) + add + v.slice(end), s + add.length);
                }
                break;
            }
            case "deleteContentBackward":
            case "deleteContentForward":
            case "deleteWordBackward":
            case "deleteWordForward":
            case "deleteSoftLineBackward":
            case "deleteSoftLineForward":
            case "deleteHardLineBackward":
            case "deleteHardLineForward":
            case "deleteByCut": {
                let a = s;
                let b = end;
                if (a === b) {
                    const back = e.inputType.endsWith("Backward");
                    const whole = !/Content/.test(e.inputType); // word or line: everything on that side
                    a = back ? (whole ? 0 : Math.max(0, s - 1)) : s;
                    b = back ? s : (whole ? v.length : Math.min(v.length, s + 1));
                }
                if (a !== b) {
                    put(v.slice(0, a) + v.slice(b), a);
                }
                break;
            }
            // anything else (undo, redo, formatting) changes nothing
        }
    });
    const done = () => {
        if (typed) {
            typed = false;
            commit();
        }
    };
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            typed = true; // Enter goes there even when nothing was typed
            done();
            el.blur(); // closes the phone's keyboard
        } else if (step && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            step(e.key === "ArrowUp" ? 1 : -1);
            typed = false;
        }
    });
    el.addEventListener("blur", () => {
        focusing = false;
        done();
    });
    // the tap or click that focuses it would put the caret where it landed (WebKit: before the
    // number, so "13" typed over "1" read "131"): keep everything selected through it
    let focusing = false;
    el.addEventListener("focus", () => {
        el.select();
        focusing = true;
    });
    el.addEventListener("mouseup", (e) => {
        if (focusing) {
            e.preventDefault();
            el.select();
        }
        focusing = false;
    });
    el.addEventListener("keydown", () => (focusing = false), true);
}

// A plain-text `contenteditable` element holding `text`; `changed` gets the text after each
// edit. Returns a getter for the text.
export function textField(el: HTMLElement, text: string, changed: (text: string) => void): () => string {
    let value = text;
    // a text ending in a line break needs a second one, or the caret can't go onto the new line
    const show = () => (el.textContent = value + (value.endsWith("\n") ? "\n" : ""));
    show();
    const offset = (node: Node, at: number) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.setEnd(node, at);
        return Math.min(value.length, r.toString().length);
    };
    const GRAIN: Record<string, "character" | "word" | "lineboundary"> = {
        deleteContentBackward: "character", deleteContentForward: "character",
        deleteWordBackward: "word", deleteWordForward: "word",
        deleteSoftLineBackward: "lineboundary", deleteSoftLineForward: "lineboundary",
        deleteHardLineBackward: "lineboundary", deleteHardLineForward: "lineboundary",
    };
    el.addEventListener("beforeinput", (e) => {
        const type = e.inputType;
        if (type === "insertCompositionText" || !e.cancelable) {
            return; // the browser types it; read back on input
        }
        e.preventDefault();
        const sel = getSelection();
        if (!sel?.rangeCount) {
            return;
        }
        let ins: string;
        if (type === "insertParagraph" || type === "insertLineBreak") {
            ins = "\n";
        } else if (type.startsWith("insert")) {
            ins = (e.data ?? e.dataTransfer?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
        } else if (type.startsWith("delete")) {
            ins = "";
        } else {
            return; // undo, redo, formatting: nothing
        }
        // where: the browser's own range (an autocorrected word), else the selection, else
        // the selection extended by what the delete removes (Chrome gives no range for those)
        let r: AbstractRange = e.getTargetRanges()[0] ?? sel.getRangeAt(0);
        if (r.collapsed && type !== "insertText" && sel.getRangeAt(0).collapsed && GRAIN[type]) {
            sel.modify("extend", type.endsWith("Backward") ? "backward" : "forward", GRAIN[type]);
            r = sel.getRangeAt(0);
        } else if (r.collapsed && !sel.getRangeAt(0).collapsed) {
            r = sel.getRangeAt(0);
        }
        const a = offset(r.startContainer, r.startOffset);
        const z = offset(r.endContainer, r.endOffset);
        if (a === z && !ins) {
            return;
        }
        value = value.slice(0, a) + ins + value.slice(z);
        show();
        sel.collapse(el.firstChild ?? el, el.firstChild ? a + ins.length : 0);
        changed(value);
    });
    el.addEventListener("input", () => {
        // only typing the browser made itself (composed) reaches here
        value = (el.textContent ?? "").replace(/\n\n$/, "\n");
        changed(value);
    });
    return () => value;
}
