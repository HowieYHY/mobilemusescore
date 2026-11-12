// Panels close with the phone's Back button or gesture instead of leaving the app: each open panel
// adds a history entry, and going back closes the top one. Kept apart from main.ts so it can be tested
// under Node against a stand-in for the browser's history (scripts/layers-test.mjs).
//
// The rule that keeps it right: one history entry per open panel, always. Every panel that closes gives
// one entry back, whether it was the top one or not (the entries are all alike, so it doesn't matter
// which); every panel that opens takes one. What is asked of the browser is worked out at the end of the
// app's own turn, so a close and an open in the same turn cancel out (one panel taking another's place
// keeps its entry), and several closes become one step back.

export interface LayerHistory {
    pushState(data: unknown, unused: string): void;
    go(delta: number): void;
}

export function makeLayers(history: LayerHistory, onPopState: (handler: () => void) => void) {
    const layers: (() => void)[] = [];

    // entries to give back, not yet asked of the browser (asked together when this turn ends)
    let backsWanted = 0;
    // popstates of our own going back still to come, which close nothing: their panels closed already
    let ownPops = 0;
    // entries for panels opened while such a going back was on its way, added once it has landed
    let laterPushes = 0;

    function addEntries() {
        for (; laterPushes > 0; laterPushes--) {
            history.pushState({ pocketscoreLayer: layers.length - laterPushes + 1 }, "");
        }
    }

    function takeEntry() {
        if (backsWanted > 0) {
            backsWanted--; // the entry of a panel closed in this same turn
        } else if (ownPops > 0) {
            laterPushes++;
        } else {
            history.pushState({ pocketscoreLayer: layers.length }, "");
        }
    }

    function giveEntry() {
        if (laterPushes > 0) {
            laterPushes--; // its entry was never added
            return;
        }
        if (++backsWanted === 1) {
            queueMicrotask(() => {
                const n = backsWanted;
                backsWanted = 0;
                if (n > 0) {
                    ownPops++;
                    history.go(-n); // one step, so one popstate, however many entries
                } else if (ownPops === 0) {
                    addEntries();
                }
            });
        }
    }

    function openLayer(close: () => void) {
        layers.push(close);
        takeEntry();
    }

    /** Close a panel from the app's own controls: at once, with history following. Leaving the closing to
     *  the late popstate let a second close in the meantime (the palette's tap-away, then Notes giving way to
     *  Edit) go back twice, and the second popstate closed the panel just opened. A panel under another
     *  gives its entry back too: it used to keep it, and Back then did nothing once (bug hunt, finding 16). */
    function closeLayer(close: () => void) {
        const i = layers.lastIndexOf(close);
        if (i >= 0) {
            layers.splice(i, 1);
            giveEntry();
        }
        close();
    }

    /** One mode in place of another (Notes and Edit): the new one takes the old one's Back entry. */
    function swapLayer(from: () => void, to: () => void) {
        const i = layers.lastIndexOf(from);
        if (i < 0) {
            openLayer(to);
        } else {
            layers[i] = to;
        }
    }

    /** A panel of which one is open at a time: the `others` that are open close, and it takes over
     *  the Back entry of one of them (closing them through history first happened later and closed the
     *  new one). Two closing for one (the Mixer with a sound list) gives the second entry back. */
    function openSheet(close: () => void, others: (() => void)[]) {
        for (let i = layers.length - 1; i >= 0; i--) {
            // (a panel's own close may have closed another on the way: the Mixer closes its sound list)
            if (i < layers.length && others.includes(layers[i])) {
                closeLayer(layers[i]);
            }
        }
        openLayer(close);
    }

    onPopState(() => {
        if (ownPops > 0) {
            if (--ownPops === 0 && backsWanted === 0) {
                addEntries();
            }
            return;
        }
        layers.pop()?.();
    });

    return { layers, openLayer, closeLayer, swapLayer, openSheet };
}
